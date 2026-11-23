#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>
#import <PDFKit/PDFKit.h>

// These entry points use the application renderer. The second pauses only before opening the print panel.
extern int lofold_mail_image(const uint8_t *source, size_t length, uint8_t **out, size_t *size);
extern int lofold_capture_print_pdf_for_test(const uint8_t *source, size_t length, uint8_t **out, size_t *size);
extern void lofold_free_mail_image(uint8_t *bytes);

static void fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String ?: "Native reader output test failed.");
    exit(1);
}

static BOOL nearColor(const uint8_t *pixel, const uint8_t *color) {
    const int tolerance = 9;
    for (size_t component = 0; component < 3; ++component) {
        if (abs(pixel[component] - color[component]) > tolerance) return NO;
    }
    return YES;
}

static NSArray *colorProbes(CGImageRef image, NSArray<NSString *> *probeHex) {
    size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
    size_t stride = width * 4;
    CGColorSpaceRef colors = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef bitmap = CGBitmapContextCreate(NULL, width, height, 8, stride, colors,
        kCGImageAlphaNoneSkipLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(colors);
    if (!bitmap) return nil;
    CGContextDrawImage(bitmap, CGRectMake(0, 0, width, height), image);
    const uint8_t *pixels = CGBitmapContextGetData(bitmap);
    NSMutableArray *results = [NSMutableArray arrayWithCapacity:probeHex.count];
    for (NSString *hex in probeHex) {
        unsigned int rgb = 0;
        NSScanner *scanner = [NSScanner scannerWithString:hex];
        if (hex.length != 6 || ![scanner scanHexInt:&rgb] || !scanner.isAtEnd) {
            CGContextRelease(bitmap);
            return nil;
        }
        uint8_t color[] = {(uint8_t)(rgb >> 16), (uint8_t)(rgb >> 8), (uint8_t)rgb};
        NSUInteger count = 0;
        size_t minX = width, minY = height, maxX = 0, maxY = 0;
        for (size_t y = 0; y < height; ++y) {
            for (size_t x = 0; x < width; ++x) {
                if (!nearColor(pixels + y * stride + x * 4, color)) continue;
                count++;
                minX = MIN(minX, x); minY = MIN(minY, y);
                maxX = MAX(maxX, x); maxY = MAX(maxY, y);
            }
        }
        [results addObject:@{@"color": hex, @"count": @(count),
            @"bounds": count ? @[@(minX), @(minY), @(maxX), @(maxY)] : @[]}];
    }
    CGContextRelease(bitmap);
    return results;
}

static NSDictionary *inspectPNG(NSData *png, NSArray<NSString *> *probes) {
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)png, NULL);
    CGImageRef image = source ? CGImageSourceCreateImageAtIndex(source, 0, NULL) : NULL;
    if (source) CFRelease(source);
    if (!image) return nil;
    NSArray *matches = probes.count ? colorProbes(image, probes) : @[];
    NSDictionary *result = matches ? @{@"width": @(CGImageGetWidth(image)),
        @"height": @(CGImageGetHeight(image)), @"probes": matches} : nil;
    CGImageRelease(image);
    return result;
}

static NSDictionary *inspectPDF(NSData *pdf) {
    PDFDocument *document = [[PDFDocument alloc] initWithData:pdf];
    if (!document.pageCount) return nil;
    NSMutableArray *pages = [NSMutableArray arrayWithCapacity:document.pageCount];
    for (NSUInteger index = 0; index < document.pageCount; index++) {
        PDFPage *page = [document pageAtIndex:index];
        [pages addObject:page.string ?: @""];
    }
    return @{@"pages": pages};
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 4) fail(@"Usage: native-output HTML png|pdf DESTINATION [RGB_HEX ...]");
        NSString *mode = @(argv[2]), *destination = @(argv[3]);
        BOOL printing = [mode isEqualToString:@"pdf"];
        if (!printing && ![mode isEqualToString:@"png"]) fail(@"Unknown reader output mode.");
        NSData *source = [NSData dataWithContentsOfFile:@(argv[1])];
        if (!source.length) fail(@"Cannot read synthetic HTML for native reader output.");
        NSMutableArray<NSString *> *probes = [NSMutableArray array];
        for (int index = 4; index < argc; index++) [probes addObject:@(argv[index])];
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSPrintInfo.sharedPrintInfo.paperSize = NSMakeSize(595, 842);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            uint8_t *bytes = NULL;
            size_t size = 0;
            int code = printing
                ? lofold_capture_print_pdf_for_test(source.bytes, source.length, &bytes, &size)
                : lofold_mail_image(source.bytes, source.length, &bytes, &size);
            NSData *output = bytes ? [NSData dataWithBytes:bytes length:size] : nil;
            lofold_free_mail_image(bytes);
            NSDictionary *report = @{@"code": @(code)};
            if (code == 0) {
                NSDictionary *result = printing ? inspectPDF(output) : inspectPNG(output, probes);
                if (!result || ![output writeToFile:destination atomically:YES]) fail(@"Native output could not be decoded or saved.");
                report = @{@"code": @0, @"output": result};
            }
            NSData *json = [NSJSONSerialization dataWithJSONObject:report options:0 error:NULL];
            fwrite(json.bytes, 1, json.length, stdout);
            fputc('\n', stdout);
            exit(0);
        });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            fail(@"Native output scenario exceeded 50 seconds.");
        });
        [NSApp run];
        return 0;
    }
}
