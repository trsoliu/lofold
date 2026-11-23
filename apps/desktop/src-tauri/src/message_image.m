// A private, ephemeral WebKit renderer. No Tauri bridge or app window is used.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <ImageIO/ImageIO.h>
#import <PDFKit/PDFKit.h>

static NSData *Rasterize(NSData *pdf, CGSize expected) {
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)pdf);
    CGPDFDocumentRef document = CGPDFDocumentCreateWithProvider(provider);
    CGDataProviderRelease(provider);
    if (!document) return nil;
    CGPDFPageRef page = CGPDFDocumentGetNumberOfPages(document) == 1 ? CGPDFDocumentGetPage(document, 1) : NULL;
    CGRect box = page ? CGPDFPageGetBoxRect(page, kCGPDFMediaBox) : CGRectZero;
    if (!page || fabs(box.size.width - expected.width) > 2 || fabs(box.size.height - expected.height) > 2) {
        CGPDFDocumentRelease(document);
        return nil;
    }
    CGFloat scale = MIN(1.5, MIN(sqrt(32000000.0 / (box.size.width * box.size.height)), 32760.0 / box.size.height));
    size_t width = (size_t)floor(box.size.width * scale), height = (size_t)floor(box.size.height * scale);
    CGColorSpaceRef color = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, width * 4, color, (CGBitmapInfo)kCGImageAlphaNoneSkipLast);
    CGColorSpaceRelease(color);
    if (!context) { CGPDFDocumentRelease(document); return nil; }
    CGRect rect = CGRectMake(0, 0, width, height);
    CGContextSetRGBFillColor(context, 1, 1, 1, 1);
    CGContextFillRect(context, rect);
    CGContextScaleCTM(context, width / box.size.width, height / box.size.height);
    CGContextTranslateCTM(context, -box.origin.x, -box.origin.y);
    CGContextDrawPDFPage(context, page);
    CGPDFDocumentRelease(document);
    CGImageRef image = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    if (!image) return nil;
    NSMutableData *png = [NSMutableData data];
    CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)png, CFSTR("public.png"), 1, NULL);
    BOOL ok = NO;
    if (destination) {
        CGImageDestinationAddImage(destination, image, NULL);
        ok = CGImageDestinationFinalize(destination);
        CFRelease(destination);
    }
    CGImageRelease(image);
    return ok ? png : nil;
}

// Each WebKit PDF covers a single section of the source. Combining cropped
// sections prevents invisible text outside a page's bounds from being copied.
static PDFDocument *PrintableDocument(NSArray<NSData *> *slices, CGRect page) {
    NSMutableData *output = [NSMutableData data];
    CGDataConsumerRef consumer = CGDataConsumerCreateWithCFData((__bridge CFMutableDataRef)output);
    CGContextRef ctx = CGPDFContextCreate(consumer, &page, NULL);
    CGDataConsumerRelease(consumer);
    if (!ctx) return nil;
    BOOL ok = YES;
    CGRect content = CGRectInset(page, 26, 26);
    for (NSData *slice in slices) {
        CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)slice);
        CGPDFDocumentRef doc = CGPDFDocumentCreateWithProvider(provider);
        CGDataProviderRelease(provider);
        CGPDFPageRef original = doc && CGPDFDocumentGetNumberOfPages(doc) == 1 ? CGPDFDocumentGetPage(doc, 1) : NULL;
        if (!original) { if (doc) CGPDFDocumentRelease(doc); ok = NO; break; }
        CGRect source = CGPDFPageGetBoxRect(original, kCGPDFMediaBox);
        CGFloat scale = content.size.width / source.size.width;
        CGPDFContextBeginPage(ctx, NULL);
        CGContextTranslateCTM(ctx, content.origin.x, CGRectGetMaxY(content) - source.size.height * scale);
        CGContextScaleCTM(ctx, scale, scale);
        CGContextTranslateCTM(ctx, -source.origin.x, -source.origin.y);
        CGContextDrawPDFPage(ctx, original);
        CGPDFContextEndPage(ctx);
        CGPDFDocumentRelease(doc);
    }
    CGPDFContextClose(ctx);
    CGContextRelease(ctx);
    return ok ? [[PDFDocument alloc] initWithData:output] : nil;
}

@interface LFMailImage : NSObject <WKNavigationDelegate>
@property (nonatomic, strong) WKWebView *view;
@property (nonatomic) BOOL printing;
#ifdef LOFOLD_NATIVE_OUTPUT_TEST
@property (nonatomic) BOOL capturePrintPDF;
#endif
@property (nonatomic) BOOL printPanelOpen;
@property (nonatomic, strong) NSPrintOperation *printJob;
@property (nonatomic, strong) PDFDocument *printDocument;
@property (nonatomic, strong) NSPrintInfo *printInfo;
@property (nonatomic) CGRect paper;
@property (nonatomic, strong) NSArray<NSValue *> *sections;
@property (nonatomic, strong) NSMutableArray<NSData *> *slices;
@property (nonatomic) NSUInteger sliceBytes;
@property (nonatomic, copy) void (^completion)(NSData *, int);
@end

@implementation LFMailImage
- (void)finish:(NSData *)png code:(int)code {
    void (^done)(NSData *, int) = self.completion;
    if (!done) return;
    self.completion = nil;
    self.view.navigationDelegate = nil;
    [self.view stopLoading];
    self.view = nil;
    self.printJob = nil;
    self.printDocument = nil;
    done(png, code);
}
- (void)start:(NSString *)source {
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    config.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    config.defaultWebpagePreferences.allowsContentJavaScript = NO;
    if (@available(macOS 13.3, *)) config.preferences.shouldPrintBackgrounds = YES;
    self.view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 840, 32) configuration:config];
    self.view.navigationDelegate = self;
    // Enforce the resource boundary even if the caller supplies a malformed document.
    NSString *guard = @"<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'\"><style>*{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>";
    [self.view loadHTMLString:[guard stringByAppendingString:source] baseURL:nil];
    __weak LFMailImage *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 45 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (!weakSelf.printPanelOpen) [weakSelf finish:nil code:3];
    });
}
- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))handler {
    BOOL local = action.targetFrame.isMainFrame && [action.request.URL.absoluteString isEqualToString:@"about:blank"];
    handler(local ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)view didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self finish:nil code:2]; }
- (void)webView:(WKWebView *)view didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self finish:nil code:2]; }
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)view { [self finish:nil code:2]; }
- (void)printFinished:(NSPrintOperation *)job success:(BOOL)success contextInfo:(void *)context {
    [self finish:nil code:success ? 0 : 4];
}
- (void)showPrintPanel {
    self.printDocument = PrintableDocument(self.slices, self.paper);
    if (!self.printDocument.pageCount) { [self finish:nil code:2]; return; }
#ifdef LOFOLD_NATIVE_OUTPUT_TEST
    if (self.capturePrintPDF) {
        NSData *pdf = self.printDocument.dataRepresentation;
        [self finish:pdf code:pdf.length ? 0 : 2];
        return;
    }
#endif
    self.printJob = [self.printDocument printOperationForPrintInfo:self.printInfo scalingMode:kPDFPrintPageScaleDownToFit autoRotate:YES];
    if (!self.printJob) { [self finish:nil code:2]; return; }
    self.printJob.jobTitle = @"LoFold 邮件";
    self.printJob.showsPrintPanel = YES;
    self.printJob.showsProgressPanel = YES;
    self.printPanelOpen = YES;
    NSWindow *parent = NSApp.keyWindow ?: NSApp.mainWindow;
    if (parent) {
        [self.printJob runOperationModalForWindow:parent delegate:self didRunSelector:@selector(printFinished:success:contextInfo:) contextInfo:NULL];
    } else {
        BOOL success = [self.printJob runOperation];
        [self printFinished:self.printJob success:success contextInfo:NULL];
    }
}
- (void)renderNextPrintPage {
    if (!self.completion) return;
    NSUInteger index = self.slices.count;
    if (index == self.sections.count) { [self showPrintPanel]; return; }
    WKPDFConfiguration *layout = [WKPDFConfiguration new];
    layout.rect = self.sections[index].rectValue;
    [self.view createPDFWithConfiguration:layout completionHandler:^(NSData *pdf, NSError *error) {
        if (!self.completion) return;
        if (error || !pdf.length || self.sliceBytes + pdf.length > 64 * 1024 * 1024) {
            [self finish:nil code:2]; return;
        }
        self.sliceBytes += pdf.length;
        [self.slices addObject:pdf];
        [self renderNextPrintPage];
    }];
}
- (void)preparePrint:(CGSize)size breaks:(NSArray<NSNumber *> *)breaks {
    self.printInfo = [NSPrintInfo.sharedPrintInfo copy];
    CGSize paper = self.printInfo.paperSize;
    self.paper = paper.width < 180 || paper.height < 180 ? CGRectMake(0, 0, 595, 842) : CGRectMake(0, 0, paper.width, paper.height);
    CGRect content = CGRectInset(self.paper, 26, 26);
    CGFloat step = floor(content.size.height * size.width / content.size.width);
    if (step < 1 || size.height / step > 100) { [self finish:nil code:1]; return; }
    NSMutableArray *sections = [NSMutableArray array];
    for (CGFloat top = 0; top < size.height;) {
        CGFloat end = MIN(top + step, size.height);
        if (end < size.height) {
            CGFloat soft = 0;
            for (NSNumber *boundary in breaks) {
                CGFloat y = boundary.doubleValue;
                if (y > top + .78 * step && y <= end) soft = MAX(soft, y);
            }
            if (soft) end = soft;
        }
        [sections addObject:[NSValue valueWithRect:CGRectMake(0, top, size.width, end - top)]];
        top = end;
    }
    self.sections = sections;
    self.slices = [NSMutableArray arrayWithCapacity:sections.count];
    [self renderNextPrintPage];
}
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    // The isolated client world measures unscrolled layout. Message scripts are disabled.
    NSString *measure = @"const d=document.documentElement,b=document.body;const breaks=printing?Array.from(b.querySelectorAll('p,li,tr,blockquote,h1,h2,h3,pre,img')).slice(0,8192).map(e=>Math.ceil(e.getBoundingClientRect().bottom)):[];return [Math.max(d.scrollWidth,b.scrollWidth),Math.max(d.scrollHeight,b.scrollHeight),breaks];";
    [view callAsyncJavaScript:measure arguments:@{@"printing":@(self.printing)} inFrame:nil inContentWorld:WKContentWorld.defaultClientWorld completionHandler:^(id size, NSError *error) {
        if (!self.completion) return;
        if (error || ![size isKindOfClass:NSArray.class] || [size count] != 3) { [self finish:nil code:2]; return; }
        CGFloat w = ceil([size[0] doubleValue]), h = ceil([size[1] doubleValue]);
        if (w < 1 || h < 1 || w > 2400 || h > 32760 || w * h > 32000000) { [self finish:nil code:1]; return; }
        if (self.printing) {
            [self preparePrint:CGSizeMake(w, h) breaks:size[2]];
            return;
        }
        WKPDFConfiguration *layout = [WKPDFConfiguration new];
        layout.rect = CGRectMake(0, 0, w, h);
        [view createPDFWithConfiguration:layout completionHandler:^(NSData *pdf, NSError *pdfError) {
            if (!self.completion) return;
            if (!pdf || pdfError) { [self finish:nil code:2]; return; }
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                @autoreleasepool {
                    NSData *png = Rasterize(pdf, CGSizeMake(w, h));
                    dispatch_async(dispatch_get_main_queue(), ^{ [self finish:png code:png ? 0 : 2]; });
                }
            });
        }];
    }];
}
@end

// Called on a blocking worker. The main run loop continues serving WebKit.
static int PerformMailOutput(const uint8_t *source, size_t length, BOOL printing, uint8_t **out, size_t *size) {
    @autoreleasepool {
        if ([NSThread isMainThread] || length > 12 * 1024 * 1024) return 2;
        NSString *html = [[NSString alloc] initWithBytes:source length:length encoding:NSUTF8StringEncoding];
        if (!html) return 2;
        dispatch_semaphore_t signal = dispatch_semaphore_create(0);
        __block NSData *result = nil;
        __block int code = 2;
        dispatch_async(dispatch_get_main_queue(), ^{
            __block LFMailImage *task = [LFMailImage new];
            task.printing = printing;
#ifdef LOFOLD_NATIVE_OUTPUT_TEST
            task.capturePrintPDF = printing && out != NULL;
#endif
            task.completion = ^(NSData *png, int status) {
                result = png;
                code = status;
                task = nil;
                dispatch_semaphore_signal(signal);
            };
            [task start:html];
        });
        dispatch_semaphore_wait(signal, DISPATCH_TIME_FOREVER);
        if (code != 0 || !out) return code;
        if (!result.length) return 2;
        *out = malloc(result.length);
        if (!*out) return 2;
        memcpy(*out, result.bytes, result.length);
        *size = result.length;
        return 0;
    }
}
void lofold_free_mail_image(uint8_t *bytes) { free(bytes); }

int lofold_mail_image(const uint8_t *source, size_t length, uint8_t **out, size_t *size) {
    return PerformMailOutput(source, length, NO, out, size);
}

int lofold_print_mail(const uint8_t *source, size_t length) {
    return PerformMailOutput(source, length, YES, NULL, NULL);
}

#ifdef LOFOLD_NATIVE_OUTPUT_TEST
// The smoke test captures the same paginated PDF the app hands to the system print panel.
int lofold_capture_print_pdf_for_test(const uint8_t *source, size_t length, uint8_t **out, size_t *size) {
    return PerformMailOutput(source, length, YES, out, size);
}
#endif
