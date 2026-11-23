use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use fs2::FileExt;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

use crate::Command;

const MAX_FRAME: u64 = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(3);

type Reply = Result<Value, String>;

pub fn socket_path() -> PathBuf {
    PathBuf::from(format!("/tmp/lofold-mcp-{}/bridge.sock", uid()))
}

fn uid() -> u32 {
    // geteuid does not read user input and has no failure return.
    unsafe { libc::geteuid() }
}

fn private_directory(path: &Path, create: bool) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing socket directory"))?;
    if create {
        match DirBuilder::new().mode(0o700).create(dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    let metadata = fs::symlink_metadata(dir)?;
    if metadata.is_dir() && metadata.uid() == uid() && metadata.mode() & 0o077 == 0 {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "LoFold bridge directory is not private",
        ))
    }
}

fn socket_is_private(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_socket() && metadata.uid() == uid() && metadata.mode() & 0o077 == 0 {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "LoFold bridge socket is not private",
        ))
    }
}

pub struct Bridge {
    stop: Arc<AtomicBool>,
}

impl Bridge {
    pub fn bind(
        path: PathBuf,
        mut handler: impl FnMut(Command) -> Reply + Send + 'static,
    ) -> io::Result<Self> {
        private_directory(&path, true)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path.with_extension("lock"))?;
        FileExt::try_lock_exclusive(&lock)?;
        match socket_is_private(&path) {
            Ok(()) => fs::remove_file(&path)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        let listener = UnixListener::bind(&path)?;
        let setup = fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .and_then(|()| listener.set_nonblocking(true));
        if let Err(error) = setup {
            let _ = fs::remove_file(&path);
            return Err(error);
        }

        let stop = Arc::new(AtomicBool::new(false));
        let running = stop.clone();
        let worker_path = path.clone();
        let worker = thread::Builder::new()
            .name("lofold-mcp-bridge".into())
            .spawn(move || {
                while !running.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let _ = handle_connection(&mut stream, &mut handler);
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(25))
                        }
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                        Err(_) => break,
                    }
                }
                let _ = fs::remove_file(worker_path);
                drop(lock);
            });
        match worker {
            Ok(_thread) => Ok(Self { stop }),
            Err(error) => {
                let _ = fs::remove_file(path);
                Err(error)
            }
        }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

fn handle_connection(
    stream: &mut UnixStream,
    handler: &mut impl FnMut(Command) -> Reply,
) -> io::Result<()> {
    // Accepted sockets can inherit nonblocking mode on macOS.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    let request = read_frame(stream)?;
    write_frame(stream, &handler(request))
}

pub fn call(path: &Path, command: Command) -> Reply {
    let connect = || -> io::Result<UnixStream> {
        private_directory(path, false)?;
        socket_is_private(path)?;
        let stream = UnixStream::connect(path)?;
        stream.set_read_timeout(Some(TIMEOUT))?;
        stream.set_write_timeout(Some(TIMEOUT))?;
        Ok(stream)
    };
    let mut stream =
        connect().map_err(|_| "请打开 LoFold 并在「设置 → Agent MCP」启用连接。".to_owned())?;
    write_frame(&mut stream, &command)
        .and_then(|()| read_frame(&mut stream))
        .map_err(|_| "LoFold 未返回确认。请先在应用内核对操作结果，再决定是否重试。".to_owned())?
}

fn read_frame<T: DeserializeOwned>(stream: &mut UnixStream) -> io::Result<T> {
    let mut line = Vec::new();
    BufReader::new(stream.take(MAX_FRAME + 1)).read_until(b'\n', &mut line)?;
    if line.len() as u64 > MAX_FRAME || line.last() != Some(&b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid bridge frame",
        ));
    }
    serde_json::from_slice(&line).map_err(io::Error::other)
}

fn write_frame<T: Serialize>(stream: &mut UnixStream, data: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(data).map_err(io::Error::other)?;
    if bytes.len() as u64 >= MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Bridge frame too large",
        ));
    }
    stream.write_all(&bytes)?;
    stream.write_all(b"\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn private_bridge_has_exclusive_listener_and_round_trips() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private/bridge.sock");
        let server = Bridge::bind(path.clone(), |_| Ok(json!({"enabled": true}))).unwrap();
        assert!(Bridge::bind(path.clone(), |_| Ok(Value::Null)).is_err());
        assert_eq!(
            call(&path, Command::Status).unwrap(),
            json!({"enabled": true})
        );
        assert_eq!(fs::symlink_metadata(&path).unwrap().mode() & 0o777, 0o600);
        drop(server);
    }
}
