#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

static void fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String ?: "WebKit reader test failed.");
    exit(1);
}

static void writeResult(NSData *json) {
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    exit(0);
}

@interface ReaderLayoutDriver : NSObject <WKURLSchemeHandler, WKNavigationDelegate>
@property (nonatomic, strong) NSURL *root;
@property (nonatomic, copy) NSString *scenario;
@property (nonatomic, copy) NSString *snapshotPath;
@property (nonatomic) BOOL started;
@end

@implementation ReaderLayoutDriver
- (void)webView:(WKWebView *)view startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSURL *url = task.request.URL;
    NSString *leaf = url.path;
    if (!leaf.length || [leaf isEqualToString:@"/"]) leaf = @"/index.html";
    NSURL *asset = [[self.root URLByAppendingPathComponent:[leaf substringFromIndex:1]] URLByResolvingSymlinksInPath];
    BOOL internal = [url.host isEqualToString:@"app"] && [asset.path hasPrefix:[self.root.path stringByAppendingString:@"/"]];
    NSDictionary *types = @{@"html": @"text/html", @"css": @"text/css",
        @"js": @"text/javascript", @"svg": @"image/svg+xml", @"json": @"application/json",
        @"png": @"image/png", @"jpg": @"image/jpeg", @"webp": @"image/webp",
        @"woff2": @"font/woff2"};
    NSString *type = types[asset.pathExtension];
    NSData *data = internal && type ? [NSData dataWithContentsOfURL:asset] : nil;
    if (!data) {
        [task didFailWithError:[NSError errorWithDomain:@"ReaderLayoutFixture" code:404 userInfo:nil]];
        return;
    }
    NSURLResponse *response = [[NSURLResponse alloc] initWithURL:url MIMEType:type
        expectedContentLength:data.length textEncodingName:@"utf-8"];
    [task didReceiveResponse:response];
    [task didReceiveData:data];
    [task didFinish];
}

- (void)webView:(WKWebView *)view stopURLSchemeTask:(id<WKURLSchemeTask>)task {}

- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action
        decisionHandler:(void (^)(WKNavigationActionPolicy))decide {
    NSURL *url = action.request.URL;
    BOOL local = [url.scheme isEqualToString:@"lofold-layout"] && [url.host isEqualToString:@"app"];
    BOOL about = [url.absoluteString isEqualToString:@"about:srcdoc"] || [url.absoluteString isEqualToString:@"about:blank"];
    decide(local || (about && !action.targetFrame.isMainFrame) ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView *)view didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    fail(error.localizedDescription);
}

- (void)webView:(WKWebView *)view didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    fail(error.localizedDescription);
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)view {
    fail(@"WebKit content process stopped during reader test.");
}

- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    if (self.started) return;
    self.started = YES;
    NSString *source = [NSString stringWithFormat:@"return await (%@);", self.scenario];
    [view callAsyncJavaScript:source arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld
        completionHandler:^(id result, NSError *error) {
        if (error || !result) fail(error.description ?: @"Reader scenario returned no measurements.");
        NSError *encodeError = nil;
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:&encodeError];
        if (!json) fail(encodeError.localizedDescription);
        if (!self.snapshotPath.length) { writeResult(json); return; }
        WKSnapshotConfiguration *capture = [WKSnapshotConfiguration new];
        capture.afterScreenUpdates = NO;
        [view takeSnapshotWithConfiguration:capture completionHandler:^(NSImage *image, NSError *imageError) {
            NSData *tiff = image.TIFFRepresentation;
            NSBitmapImageRep *bitmap = tiff.length ? [[NSBitmapImageRep alloc] initWithData:tiff] : nil;
            NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            if (![png writeToFile:self.snapshotPath atomically:YES]) {
                fprintf(stderr, "WebKit snapshot unavailable: %s\n",
                    imageError.localizedDescription.UTF8String ?: "conversion failed");
            }
            writeResult(json);
        }];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            fprintf(stderr, "WebKit snapshot timed out; preserving measurements.\n");
            writeResult(json);
        });
    }];
}
@end

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 7) fail(@"Usage: wk-runner DIST INIT_JS SCENARIO_JS WIDTH HEIGHT SNAPSHOT_OR_DASH");
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSString *fixture = [NSString stringWithContentsOfFile:@(argv[2]) encoding:NSUTF8StringEncoding error:NULL];
        ReaderLayoutDriver *driver = [ReaderLayoutDriver new];
        driver.root = [[NSURL fileURLWithPath:@(argv[1]) isDirectory:YES] URLByResolvingSymlinksInPath];
        driver.scenario = [NSString stringWithContentsOfFile:@(argv[3]) encoding:NSUTF8StringEncoding error:NULL];
        if (!fixture.length || !driver.scenario.length) fail(@"Cannot read the synthetic fixture or scenario script.");
        if (strcmp(argv[6], "-") != 0) driver.snapshotPath = @(argv[6]);

        WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        if (@available(macOS 14.0, *)) configuration.preferences.inactiveSchedulingPolicy = WKInactiveSchedulingPolicyNone;
        [configuration setURLSchemeHandler:driver forURLScheme:@"lofold-layout"];
        WKUserScript *setup = [[WKUserScript alloc] initWithSource:fixture
            injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
        [configuration.userContentController addUserScript:setup];

        NSRect frame = NSMakeRect(0, 0, atoi(argv[4]), atoi(argv[5]));
        WKWebView *view = [[WKWebView alloc] initWithFrame:frame configuration:configuration];
        view.navigationDelegate = driver;
        // An attached view paints and decodes media without a frontmost app or a user account.
        NSWindow *window = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless
            backing:NSBackingStoreBuffered defer:YES];
        window.contentView = view;

        // Load only the synthetic build. A network regression cannot contact an external site.
        NSURL *storeURL = [[NSURL fileURLWithPath:@(argv[0])] URLByDeletingLastPathComponent];
        WKContentRuleListStore *ruleStore = [WKContentRuleListStore storeWithURL:storeURL];
        NSString *rules = @"[{\"trigger\":{\"url-filter\":\"^https?://\"},\"action\":{\"type\":\"block\"}},{\"trigger\":{\"url-filter\":\"^wss?://\"},\"action\":{\"type\":\"block\"}}]";
        [ruleStore compileContentRuleListForIdentifier:@"lofold-reader-offline" encodedContentRuleList:rules
            completionHandler:^(WKContentRuleList *list, NSError *error) {
            if (!list) fail(error.localizedDescription);
            [configuration.userContentController addContentRuleList:list];
            [view loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"lofold-layout://app/"]]];
        }];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 25 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            fail(driver.started ? @"Native WebKit reader scenario exceeded 25 seconds." : @"Native WebKit fixture failed to load within 25 seconds.");
        });
        [NSApp run];
        return window.contentView == view && driver.root ? 0 : 1;
    }
}
