package org.lofold.client

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.annotation.Keep
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Keep
object LoFoldBridge {
    private const val provider = "AndroidKeyStore"
    private const val cipherName = "AES/GCM/NoPadding"
    private const val ivBytes = 12
    private val revision = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

    private fun preferences(app: Context, service: String) =
        app.getSharedPreferences("vault-v1-$service", Context.MODE_PRIVATE)

    private fun wrappingKey(service: String, mayCreate: Boolean): SecretKey {
        val alias = "org.lofold.client.vault-v1.$service"
        val store = KeyStore.getInstance(provider).apply { load(null) }
        val existing = store.getKey(alias, null)
        if (existing != null) return existing as SecretKey
        check(mayCreate)
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, provider)
        generator.init(KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build())
        return generator.generateKey()
    }

    @JvmStatic @Synchronized
    fun get(app: Context, service: String, key: String): ByteArray? {
        val saved = preferences(app, service).getString(key, null) ?: return null
        val record = Base64.decode(saved, Base64.NO_WRAP)
        require(record.size >= ivBytes + 16)
        val cipher = Cipher.getInstance(cipherName)
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey(service, false),
            GCMParameterSpec(128, record, 0, ivBytes))
        cipher.updateAAD("$service\u0000$key".toByteArray(Charsets.UTF_8))
        return cipher.doFinal(record, ivBytes, record.size - ivBytes)
    }

    @JvmStatic @Synchronized
    fun set(app: Context, service: String, key: String, value: ByteArray) {
        try {
            val records = preferences(app, service)
            val cipher = Cipher.getInstance(cipherName)
            cipher.init(Cipher.ENCRYPT_MODE, wrappingKey(service, records.all.isEmpty()))
            cipher.updateAAD("$service\u0000$key".toByteArray(Charsets.UTF_8))
            val ciphertext = cipher.iv + cipher.doFinal(value)
            check(cipher.iv.size == ivBytes)
            check(records.edit().putString(key, Base64.encodeToString(ciphertext, Base64.NO_WRAP)).commit())
        } finally {
            value.fill(0)
        }
    }

    @JvmStatic @Synchronized
    fun remove(app: Context, service: String, key: String) {
        check(preferences(app, service).edit().remove(key).commit())
    }

    @JvmStatic @Synchronized
    fun deleteAccount(app: Context, service: String, address: String, active: String) {
        fun belongs(key: String) = key == address ||
            (key.startsWith("$address:") && revision.matches(key.substring(address.length + 1)))
        require(address.isNotEmpty() && belongs(active))
        val records = preferences(app, service)
        val edit = records.edit()
        records.all.keys.filter(::belongs).forEach { edit.remove(it) }
        check(edit.commit())
    }

    private fun document(value: String) = Uri.parse(value).also {
        require(it.scheme == "content" && !it.authority.isNullOrEmpty())
    }

    @JvmStatic
    fun openDocument(app: Context, value: String, write: Boolean): Int {
        val uri = document(value)
        val descriptor = requireNotNull(app.contentResolver.openFileDescriptor(uri, if (write) "wt" else "r"))
        return descriptor.use { it.detachFd() }
    }

    @JvmStatic
    fun documentName(app: Context, value: String): String {
        val uri = document(value)
        return app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        }?.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("Missing document name")
    }
}
