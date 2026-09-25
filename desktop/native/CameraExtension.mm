#import <Foundation/Foundation.h>
#import <CoreMediaIO/CoreMediaIO.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreMedia/CoreMedia.h>
#import <IOKit/audio/IOAudioTypes.h>
#include "CameraShared.hpp"
#include <cassert>

@interface StippleStream : NSObject <CMIOExtensionStreamSource> {
  CMVideoFormatDescriptionRef _description;
  CVPixelBufferPoolRef _pool;
  dispatch_source_t _timer;
  stipple::LatestFrame _latest;
  NSUInteger _clients;
}
- (void)acceptSample:(CMSampleBufferRef)sample;
- (void)clearFrame;
@property(nonatomic, strong) CMIOExtensionStream *stream;
@property(atomic, readonly) NSArray<CMIOExtensionStreamFormat *> *formats;
@end

@implementation StippleStream
- (instancetype)init {
  self = [super init];
  if (!self) return nil;
  if (CMVideoFormatDescriptionCreate(kCFAllocatorDefault, kCVPixelFormatType_32BGRA, stipple::width, stipple::height, nullptr, &_description) != noErr) return nil;
  NSDictionary *attrs = @{
    (id)kCVPixelBufferWidthKey: @(stipple::width), (id)kCVPixelBufferHeightKey: @(stipple::height),
    (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
    (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
  };
  if (CVPixelBufferPoolCreate(kCFAllocatorDefault, nullptr, (__bridge CFDictionaryRef)attrs, &_pool) != kCVReturnSuccess) return nil;
  _stream = [[CMIOExtensionStream alloc] initWithLocalizedName:@"Stipple Cam Video"
    streamID:[[NSUUID alloc] initWithUUIDString:@"DC31D25B-EAF6-438E-AC76-367551D62570"]
    direction:CMIOExtensionStreamDirectionSource clockType:CMIOExtensionStreamClockTypeHostTime source:self];
  return self;
}
- (NSArray<CMIOExtensionStreamFormat *> *)formats {
  return @[[CMIOExtensionStreamFormat streamFormatWithFormatDescription:_description maxFrameDuration:CMTimeMake(1, 30) minFrameDuration:CMTimeMake(1, 30) validFrameDurations:nil]];
}
- (NSSet<CMIOExtensionProperty> *)availableProperties {
  return [NSSet setWithArray:@[CMIOExtensionPropertyStreamActiveFormatIndex, CMIOExtensionPropertyStreamFrameDuration]];
}
- (CMIOExtensionStreamProperties *)streamPropertiesForProperties:(NSSet<CMIOExtensionProperty> *)properties error:(NSError **)error {
  CMIOExtensionStreamProperties *p = [CMIOExtensionStreamProperties streamPropertiesWithDictionary:@{}];
  p.activeFormatIndex = @0;
  p.frameDuration = CFBridgingRelease(CMTimeCopyAsDictionary(CMTimeMake(1, 30), kCFAllocatorDefault));
  return p;
}
- (BOOL)setStreamProperties:(CMIOExtensionStreamProperties *)properties error:(NSError **)error {
  BOOL valid = !properties.activeFormatIndex || properties.activeFormatIndex.integerValue == 0;
  if (properties.frameDuration) valid &= CMTimeCompare(CMTimeMakeFromDictionary((__bridge CFDictionaryRef)properties.frameDuration), CMTimeMake(1, 30)) == 0;
  if (!valid && error) *error = [NSError errorWithDomain:NSOSStatusErrorDomain code:kCMIOHardwareUnsupportedOperationError userInfo:nil];
  return valid;
}
- (BOOL)authorizedToStartStreamForClient:(CMIOExtensionClient *)client { return YES; }
- (BOOL)startStreamAndReturnError:(NSError **)error {
  if (_clients++ > 0) return YES;
  _timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(_timer, DISPATCH_TIME_NOW, NSEC_PER_SEC / 30, NSEC_PER_MSEC);
  __weak StippleStream *weakSelf = self;
  dispatch_source_set_event_handler(_timer, ^{ [weakSelf sendFrame]; });
  dispatch_resume(_timer);
  return YES;
}
- (void)sendFrame {
  @autoreleasepool {
    CVPixelBufferRef pixel = nullptr;
    NSDictionary *limits = @{ (id)kCVPixelBufferPoolAllocationThresholdKey: @6 };
    if (CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, _pool, (__bridge CFDictionaryRef)limits, &pixel) != kCVReturnSuccess) return;
    CVPixelBufferRef latest = _latest.current();
    if (latest) {
      CVPixelBufferRelease(pixel);
      pixel = CVPixelBufferRetain(latest);
    } else {
      CVPixelBufferLockBaseAddress(pixel, 0);
      auto *bytes = static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(pixel));
      size_t stride = CVPixelBufferGetBytesPerRow(pixel);
      for (size_t y = 0; y < stipple::height; y++) {
        auto *row = reinterpret_cast<uint32_t *>(bytes + y * stride);
        for (size_t x = 0; x < stipple::width; x++) row[x] = 0xFF000000;
      }
      CVPixelBufferUnlockBaseAddress(pixel, 0);
    }
    CMTime time = CMClockGetTime(CMClockGetHostTimeClock());
    CMSampleTimingInfo timing = { CMTimeMake(1, 30), time, kCMTimeInvalid };
    CMSampleBufferRef sample = nullptr;
    if (CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, pixel, _description, &timing, &sample) == noErr) {
      uint64_t nanos = CMTimeConvertScale(time, 1000000000, kCMTimeRoundingMethod_Default).value;
      [_stream sendSampleBuffer:sample discontinuity:CMIOExtensionStreamDiscontinuityFlagNone hostTimeInNanoseconds:nanos];
      CFRelease(sample);
    }
    CVPixelBufferRelease(pixel);
  }
}
- (BOOL)stopStreamAndReturnError:(NSError **)error {
  if (_clients > 0 && --_clients == 0 && _timer) {
    dispatch_source_cancel(_timer); _timer = nil;
  }
  return YES;
}
- (void)acceptSample:(CMSampleBufferRef)sample { _latest.accept(sample); }
- (void)clearFrame { _latest.clear(); }
- (void)dealloc {
  if (_timer) dispatch_source_cancel(_timer);
  if (_pool) CVPixelBufferPoolRelease(_pool);
  if (_description) CFRelease(_description);
}
@end

// The app writes to this sink; meeting apps consume the source above.
@interface StippleSink : NSObject <CMIOExtensionStreamSource> {
  dispatch_source_t _timer;
  CMIOExtensionClient *_client;
  BOOL _pending;
  NSUInteger _generation;
}
@property(nonatomic, strong) CMIOExtensionStream *stream;
@property(nonatomic, strong) StippleStream *output;
- (instancetype)initWithOutput:(StippleStream *)output;
- (void)disconnectClient:(CMIOExtensionClient *)client;
@end
@implementation StippleSink
- (instancetype)initWithOutput:(StippleStream *)output {
  self = [super init];
  if (self) {
    _output = output;
    _stream = [[CMIOExtensionStream alloc] initWithLocalizedName:@"Stipple Cam Input"
      streamID:[[NSUUID alloc] initWithUUIDString:@"C74C30B0-5F03-40E4-90EC-514B62CF4299"]
      direction:CMIOExtensionStreamDirectionSink clockType:CMIOExtensionStreamClockTypeHostTime source:self];
  }
  return self;
}
- (NSArray<CMIOExtensionStreamFormat *> *)formats { return _output.formats; }
- (NSSet<CMIOExtensionProperty> *)availableProperties {
  return [NSSet setWithArray:@[CMIOExtensionPropertyStreamActiveFormatIndex, CMIOExtensionPropertyStreamFrameDuration,
    CMIOExtensionPropertyStreamSinkBufferQueueSize, CMIOExtensionPropertyStreamSinkBuffersRequiredForStartup]];
}
- (CMIOExtensionStreamProperties *)streamPropertiesForProperties:(NSSet<CMIOExtensionProperty> *)properties error:(NSError **)error {
  CMIOExtensionStreamProperties *p = [_output streamPropertiesForProperties:properties error:error];
  p.sinkBufferQueueSize = @3; p.sinkBuffersRequiredForStartup = @1;
  return p;
}
- (BOOL)setStreamProperties:(CMIOExtensionStreamProperties *)properties error:(NSError **)error { return [_output setStreamProperties:properties error:error]; }
- (BOOL)authorizedToStartStreamForClient:(CMIOExtensionClient *)client {
  if (_client && ![_client.clientID isEqual:client.clientID]) return NO;
  // CMIO can report "unknown" for a signed host, and the extension sandbox
  // cannot inspect another process with SecCode. Use the public CMIO sink
  // contract: one local writer at a time, with bounded, validated frames.
  _client = client;
  return YES;
}
- (BOOL)startStreamAndReturnError:(NSError **)error {
  if (_timer) return YES;
  if (!_client) return NO;
  _generation++;
  _timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(_timer, DISPATCH_TIME_NOW, NSEC_PER_SEC / 30, NSEC_PER_MSEC);
  __weak StippleSink *weakSelf = self;
  dispatch_source_set_event_handler(_timer, ^{ [weakSelf consume]; });
  dispatch_resume(_timer);
  return YES;
}
- (void)consume {
  if (!_timer || !_client || _pending) return;
  _pending = YES;
  NSUInteger generation = _generation;
  __weak StippleSink *weakSelf = self;
  [_stream consumeSampleBufferFromClient:_client completionHandler:^(CMSampleBufferRef sample, uint64_t sequence, CMIOExtensionStreamDiscontinuityFlags flags, BOOL more, NSError *error) {
    if (sample) CFRetain(sample);
    dispatch_async(dispatch_get_main_queue(), ^{
      StippleSink *self = weakSelf;
      if (self && generation == self->_generation) {
        self->_pending = NO;
        if (self->_timer && sample && !error) {
          [self.output acceptSample:sample];
          [self.stream notifyScheduledOutputChanged:[CMIOExtensionScheduledOutput scheduledOutputWithSequenceNumber:sequence hostTimeInNanoseconds:stipple::now()]];
        }
        // Drain the small queue to keep latency bounded when delivery is bursty.
        if (self->_timer && more) [self consume];
      }
      if (sample) CFRelease(sample);
    });
  }];
}
- (BOOL)stopStreamAndReturnError:(NSError **)error {
  _generation++; _pending = NO;
  if (_timer) { dispatch_source_cancel(_timer); _timer = nil; }
  _client = nil; [_output clearFrame];
  return YES;
}
- (void)disconnectClient:(CMIOExtensionClient *)client {
  if ([_client.clientID isEqual:client.clientID]) [self stopStreamAndReturnError:nil];
}
- (void)dealloc { if (_timer) dispatch_source_cancel(_timer); }
@end

@interface StippleDevice : NSObject <CMIOExtensionDeviceSource>
@property(nonatomic, strong) CMIOExtensionDevice *device;
@property(nonatomic, strong) StippleStream *source;
@property(nonatomic, strong) StippleSink *sink;
@end
@implementation StippleDevice
- (instancetype)init {
  self = [super init];
  if (!self) return nil;
  _source = [StippleStream new];
  if (!_source) return nil;
  _device = [[CMIOExtensionDevice alloc] initWithLocalizedName:@"Stipple Cam"
    deviceID:[[NSUUID alloc] initWithUUIDString:@"2EC8E394-118B-40EB-9E92-B5FE638326E9"]
    legacyDeviceID:@"com.tomjohn.stipplecam.camera" source:self];
  NSError *error = nil;
  if (![_device addStream:_source.stream error:&error]) { NSLog(@"%@", error); return nil; }
  _sink = [[StippleSink alloc] initWithOutput:_source];
  if (![_device addStream:_sink.stream error:&error]) { NSLog(@"%@", error); return nil; }
  return self;
}
- (NSSet<CMIOExtensionProperty> *)availableProperties { return [NSSet setWithArray:@[CMIOExtensionPropertyDeviceModel, CMIOExtensionPropertyDeviceTransportType]]; }
- (CMIOExtensionDeviceProperties *)devicePropertiesForProperties:(NSSet<CMIOExtensionProperty> *)properties error:(NSError **)error {
  CMIOExtensionDeviceProperties *p = [CMIOExtensionDeviceProperties devicePropertiesWithDictionary:@{}];
  p.model = @"Stipple Cam"; p.transportType = @(kIOAudioDeviceTransportTypeVirtual);
  return p;
}
- (BOOL)setDeviceProperties:(CMIOExtensionDeviceProperties *)properties error:(NSError **)error { return YES; }
@end

@interface StippleProvider : NSObject <CMIOExtensionProviderSource>
@property(nonatomic, strong) CMIOExtensionProvider *provider;
@property(nonatomic, strong) StippleDevice *source;
@end
@implementation StippleProvider
- (instancetype)init {
  self = [super init];
  if (!self) return nil;
  _source = [StippleDevice new];
  if (!_source) return nil;
  _provider = [[CMIOExtensionProvider alloc] initWithSource:self clientQueue:dispatch_get_main_queue()];
  NSError *error = nil;
  if (![_provider addDevice:_source.device error:&error]) { NSLog(@"%@", error); return nil; }
  return self;
}
- (BOOL)connectClient:(CMIOExtensionClient *)client error:(NSError **)error { return YES; }
- (void)disconnectClient:(CMIOExtensionClient *)client { [_source.sink disconnectClient:client]; }
- (NSSet<CMIOExtensionProperty> *)availableProperties { return [NSSet setWithArray:@[CMIOExtensionPropertyProviderName, CMIOExtensionPropertyProviderManufacturer]]; }
- (CMIOExtensionProviderProperties *)providerPropertiesForProperties:(NSSet<CMIOExtensionProperty> *)properties error:(NSError **)error {
  CMIOExtensionProviderProperties *p = [CMIOExtensionProviderProperties providerPropertiesWithDictionary:@{}];
  p.name = @"Stipple Cam"; p.manufacturer = @"Stipple Cam";
  return p;
}
- (BOOL)setProviderProperties:(CMIOExtensionProviderProperties *)properties error:(NSError **)error { return YES; }
@end

static int selfTest() {
  CVPixelBufferRef pixel = nullptr;
  assert(CVPixelBufferCreate(kCFAllocatorDefault, stipple::width, stipple::height, kCVPixelFormatType_32BGRA, nullptr, &pixel) == kCVReturnSuccess);
  CMVideoFormatDescriptionRef format = nullptr;
  assert(CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pixel, &format) == noErr);
  CMSampleBufferRef sample = nullptr;
  CMSampleTimingInfo timing = { CMTimeMake(1, 30), CMTimeMake(0, 30), kCMTimeInvalid };
  assert(CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, pixel, format, &timing, &sample) == noErr);
  stipple::LatestFrame latest;
  assert(!latest.current(100));
  assert(latest.accept(sample, 100));
  assert(latest.current(101) == pixel);
  assert(!latest.current(500000100));
  assert(!latest.current(99));
  latest.clear(); assert(!latest.current(101));
  CFRelease(sample); CFRelease(format); CVPixelBufferRelease(pixel);
  StippleProvider *source = [StippleProvider new];
  assert(source && source.source.device.streams.count == 2);
  assert(source.source.source.stream.direction == CMIOExtensionStreamDirectionSource);
  assert(source.source.sink.stream.direction == CMIOExtensionStreamDirectionSink);
  NSLog(@"PASS: native camera has source/sink streams; frame lifetime, stale-frame timeout, and stop clearing verified.");
  return 0;
}
int main(int argc, const char **argv) {
  if (argc > 1 && strcmp(argv[1], "--self-test") == 0) { @autoreleasepool { return selfTest(); } }
  @autoreleasepool {
    StippleProvider *source = [StippleProvider new];
    if (!source) return 1;
    [CMIOExtensionProvider startServiceWithProvider:source.provider];
    CFRunLoopRun();
  }
  return 0;
}
