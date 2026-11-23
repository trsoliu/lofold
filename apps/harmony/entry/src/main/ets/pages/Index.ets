import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { Attachment, Detail, Imported, Page, Summary, readPickedFile, request } from '../archive/Archive';

@Entry
@Component
struct Index {
  @State items: Summary[] = [];
  @State detail: Detail | null = null;
  @State searchText: string = '';
  @State query: string = '';
  @State hasMore: boolean = false;
  @State busy: boolean = false;
  @State message: string = '';
  private dir: string = '';

  aboutToAppear(): void {
    this.dir = (getContext(this) as common.UIAbilityContext).filesDir;
    this.search();
  }

  onBackPress(): boolean {
    if (this.detail !== null) {
      this.detail = null;
      return true;
    }
    return false;
  }

  private async fetchPage(query: string, more: boolean = false): Promise<void> {
    const page = await request<Page>(this.dir, 'list', query, more ? this.items.length : 0);
    this.items = more ? this.items.concat(page.items) : page.items;
    this.query = query;
    this.hasMore = page.hasMore;
  }

  private async search(more: boolean = false): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.message = '';
    try {
      await this.fetchPage(more ? this.query : this.searchText.trim(), more);
    } catch (error) {
      this.message = (error as Error).message || '无法读取归档。';
    } finally {
      this.busy = false;
    }
  }

  private async openMail(id: number): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.message = '';
    try {
      this.detail = await request<Detail>(this.dir, 'detail', id.toString());
    } catch (error) {
      this.message = (error as Error).message || '无法读取这封邮件。';
    } finally {
      this.busy = false;
    }
  }

  private async pickMail(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.message = '';
    let added: number = 0;
    let duplicates: number = 0;
    let failed: number = 0;
    let lastError: string = '';
    try {
      const dialog = new picker.DocumentViewPicker(getContext(this) as common.UIAbilityContext);
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 20;
      options.fileSuffixFilters = ['邮件原件|.eml'];
      const files = await dialog.select(options);
      if (files.length === 0) {
        return;
      }
      for (const uri of files) {
        try {
          const bytes = await readPickedFile(uri);
          const saved = await request<Imported>(this.dir, 'import', '', 0, bytes);
          if (saved.duplicate) {
            duplicates++;
          } else {
            added++;
          }
        } catch (error) {
          failed++;
          lastError = (error as Error).message || '无法导入原件。';
        }
      }
      const report = '已归档 ' + added + ' 封，重复 ' + duplicates + ' 封';
      this.message = failed ? report + '，失败 ' + failed + ' 封。' + lastError : report + '。';
      await this.fetchPage(this.query);
    } catch (error) {
      const cause = (error as Error).message || '无法打开文件。';
      this.message += (this.message ? ' ' : '') + cause;
    } finally {
      this.busy = false;
    }
  }

  @Builder
  Header() {
    Row({ space: 10 }) {
      if (this.detail !== null) {
        Button() {
          SymbolGlyph($r('sys.symbol.chevron_backward')).fontSize(24)
        }
        .type(ButtonType.Circle).width(44).height(44).backgroundColor(Color.Transparent)
        .accessibilityText('返回邮件列表').onClick(() => { this.detail = null; })
      }
      Column({ space: 2 }) {
        Text('LoFold').fontSize(26).fontWeight(FontWeight.Bold)
        Text('本机邮件归档 · 离线版').fontSize(14).fontColor($r('sys.color.font_secondary'))
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      if (this.detail === null) {
        Button() {
          SymbolGlyph($r('sys.symbol.plus')).fontSize(24)
        }
        .type(ButtonType.Circle).width(44).height(44).enabled(!this.busy)
        .backgroundColor($r('sys.color.comp_background_tertiary'))
        .accessibilityText('导入 EML 邮件').onClick(() => { this.pickMail(); })
      }
    }.width('100%').padding({ left: 16, right: 16, top: 12, bottom: 12 })
  }

  @Builder
  MailList() {
    Search({ value: this.searchText, placeholder: '搜索主题、地址、正文或附件名' })
      .width('100%').padding({ left: 12, right: 12 })
      .enabled(!this.busy).maxLength(160).searchButton('搜索')
      .onChange((value: string) => {
        this.searchText = value;
        if (value === '' && this.query !== '') {
          this.search();
        }
      })
      .onSubmit(() => { this.search(); })
    if (this.items.length === 0 && !this.busy && !this.message) {
      Column({ space: 12 }) {
        Text(this.query ? '没有找到邮件' : '归档中还没有邮件').fontSize(20)
        if (!this.query) {
          Button('选择 EML 文件').onClick(() => { this.pickMail(); })
        }
      }.width('100%').padding(24)
    }
    List() {
      ForEach(this.items, (item: Summary) => {
        ListItem() {
          Column({ space: 5 }) {
            Text(item.subject || '（无主题）').fontSize(18).fontWeight(FontWeight.Medium)
              .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(item.sender || '（未知发件人）').fontSize(14).fontColor($r('sys.color.font_secondary'))
              .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            if (item.preview) {
              Text(item.preview).fontSize(14).fontColor($r('sys.color.font_secondary'))
                .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
            }
          }
          .width('100%').alignItems(HorizontalAlign.Start).padding(16)
          .focusable(true).onClick(() => { this.openMail(item.id); })
        }
      }, (item: Summary) => item.id.toString())
      if (this.hasMore) {
        ListItem() {
          Button('加载更多').enabled(!this.busy).onClick(() => { this.search(true); })
        }
      }
    }
    .layoutWeight(1).width('100%')
    .divider({ strokeWidth: 1, color: $r('sys.color.comp_divider'), startMargin: 16, endMargin: 16 })
  }

  @Builder
  Reader(mail: Detail) {
    Scroll() {
      Column({ space: 10 }) {
        Text(mail.subject || '（无主题）').fontSize(24).fontWeight(FontWeight.Bold)
        Text('发件人　' + (mail.sender || '未知')).fontSize(15)
        if (mail.recipients) {
          Text('收件人　' + mail.recipients).fontSize(15)
        }
        if (mail.sentAt !== null) {
          Text(new Date(mail.sentAt * 1000).toLocaleString()).fontSize(14)
            .fontColor($r('sys.color.font_secondary'))
        }
        Divider().margin({ top: 4, bottom: 4 })
        Text(mail.body || '（无可显示的正文）').fontSize(17).lineHeight(26)
          .copyOption(CopyOptions.InApp)
        if (mail.bodyTruncated) {
          Text('过长的正文仅显示前段，完整原件已归档。').fontSize(14)
        }
        if (mail.attachments.length > 0) {
          Divider()
          Text('附件').fontWeight(FontWeight.Medium)
          ForEach(mail.attachments, (part: Attachment) => {
            Text(part.name + ' · ' + part.size + ' B').fontSize(14)
          })
        }
      }
      .alignItems(HorizontalAlign.Start).width('100%').padding(16)
    }.layoutWeight(1).width('100%').align(Alignment.TopStart)
  }

  build() {
    Column() {
      this.Header()
      if (this.busy) {
        Progress({ value: 1, type: ProgressType.Linear }).width('100%')
      }
      if (this.message) {
        Text(this.message).width('100%').padding(12).fontSize(14)
      }
      if (this.detail !== null) {
        this.Reader(this.detail)
      } else {
        this.MailList()
      }
    }.height('100%').width('100%').backgroundColor($r('sys.color.background_primary'))
  }
}
