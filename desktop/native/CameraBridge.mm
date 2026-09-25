#import <Foundation/Foundation.h>
#import <SystemExtensions/SystemExtensions.h>
#import <CoreMediaIO/CoreMediaIO.h>
#include <node_api.h>
#include <vector>
#include "CameraShared.hpp"

static NSString *state = @"idle";
static NSString *detail = @"Preparing Stipple Cam.";
static uint64_t framesSent = 0;
static CMIODeviceID deviceID = 0;
static CMIOStreamID streamID = 0;
static CMSimpleQueueRef queue = nullptr;
static CMVideoFormatDescriptionRef format = nullptr;
static CVPixelBufferPoolRef pool = nullptr;
static uint64_t fullSince = 0;
static uint64_t lastConnectAttempt = 0;
static NSString *transportError = nil;

@interface ActivationDelegate : NSObject <OSSystemExtensionRequestDelegate>
@end
@implementation ActivationDelegate
- (OSSystemExtensionReplacementAction)request:(OSSystemExtensionRequest *)request actionForReplacingExtension:(OSSystemExtensionProperties *)existing withExtension:(OSSystemExtensionProperties *)replacement { return OSSystemExtensionReplacementActionReplace; }
- (void)requestNeedsUserApproval:(OSSystemExtensionRequest *)request {
  state = @"approval";
  detail = @"Allow Stipple Cam in System Settings → General → Login Items & Extensions → Camera Extensions.";
}
- (void)request:(OSSystemExtensionRequest *)request didFinishWithResult:(OSSystemExtensionRequestResult)result {
  state = result == OSSystemExtensionRequestCompleted ? @"ready" : @"restart";
  detail = result == OSSystemExtensionRequestCompleted ? @"Select Stipple Cam in your meeting app’s camera settings." : @"Restart your Mac to finish enabling Stipple Cam.";
}
- (void)request:(OSSystemExtensionRequest *)request didFailWithError:(NSError *)error {
  state = @"error";
  detail = [NSString stringWithFormat:@"Camera installation failed: %@ (%@ %ld)", error.localizedDescription, error.domain, (long)error.code];
}
@end
static ActivationDelegate *delegate;

static void stopTransport() {
  if (deviceID && streamID) CMIODeviceStopStream(deviceID, streamID);
  if (queue) {
    const void *item;
    while ((item = CMSimpleQueueDequeue(queue))) CFRelease(item);
    CFRelease(queue); queue = nullptr;
  }
  if (pool) { CVPixelBufferPoolRelease(pool); pool = nullptr; }
  if (format) { CFRelease(format); format = nullptr; }
  deviceID = 0; streamID = 0; fullSince = 0;
}

static std::vector<CMIOObjectID> objects(CMIOObjectID object, CMIOObjectPropertySelector selector) {
  CMIOObjectPropertyAddress address = { selector, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain };
  UInt32 bytes = 0, used = 0;
  if (CMIOObjectGetPropertyDataSize(object, &address, 0, nullptr, &bytes) != noErr || bytes > 65536 || bytes % sizeof(CMIOObjectID)) return {};
  std::vector<CMIOObjectID> result(bytes / sizeof(CMIOObjectID));
  if (!bytes || CMIOObjectGetPropertyData(object, &address, 0, nullptr, bytes, &used, result.data()) != noErr) return {};
  result.resize(used / sizeof(CMIOObjectID)); return result;
}

static bool connectTransport() {
  if (queue) return true;
  uint64_t now = stipple::now();
  if (now - lastConnectAttempt < 1000000000ULL) return false;
  lastConnectAttempt = now;
  for (auto candidate : objects(kCMIOObjectSystemObject, kCMIOHardwarePropertyDevices)) {
    CMIOObjectPropertyAddress address = { kCMIODevicePropertyDeviceUID, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain };
    CFStringRef uid = nullptr; UInt32 used = 0;
    if (CMIOObjectGetPropertyData(candidate, &address, 0, nullptr, sizeof(uid), &used, &uid) != noErr || !uid) continue;
    bool matches = [(__bridge NSString *)uid isEqualToString:@"com.tomjohn.stipplecam.camera"] || [(__bridge NSString *)uid caseInsensitiveCompare:@"2EC8E394-118B-40EB-9E92-B5FE638326E9"] == NSOrderedSame;
    CFRelease(uid);
    if (!matches) continue;
    for (auto stream : objects(candidate, kCMIODevicePropertyStreams)) {
      address.mSelector = kCMIOStreamPropertyDirection;
      UInt32 direction = 1;
      if (CMIOObjectGetPropertyData(stream, &address, 0, nullptr, sizeof(direction), &used, &direction) == noErr && direction == 0) { deviceID = candidate; streamID = stream; break; }
    }
  }
  if (!streamID) { transportError = @"Waiting for macOS to publish the camera. Stop and restart the camera if this persists."; return false; }
  OSStatus result = CMIOStreamCopyBufferQueue(streamID, [](CMIOStreamID, void *, void *) {}, nullptr, &queue);
  if (result != noErr || !queue) { transportError = [NSString stringWithFormat:@"Could not open the camera queue (%d).", result]; stopTransport(); return false; }
  if (CMVideoFormatDescriptionCreate(kCFAllocatorDefault, kCVPixelFormatType_32BGRA, stipple::width, stipple::height, nullptr, &format) != noErr) { stopTransport(); return false; }
  NSDictionary *attrs = @{ (id)kCVPixelBufferWidthKey: @(stipple::width), (id)kCVPixelBufferHeightKey: @(stipple::height), (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA), (id)kCVPixelBufferIOSurfacePropertiesKey: @{} };
  result = CVPixelBufferPoolCreate(kCFAllocatorDefault, nullptr, (__bridge CFDictionaryRef)attrs, &pool);
  if (result == noErr) result = CMIODeviceStartStream(deviceID, streamID);
  if (result != noErr) { transportError = [NSString stringWithFormat:@"Could not start video output (%d). Stop and restart the camera.", result]; stopTransport(); return false; }
  transportError = nil;
  return true;
}

static napi_value boolean(napi_env env, bool flag) { napi_value value; napi_get_boolean(env, flag, &value); return value; }
static void setString(napi_env env, napi_value object, const char *name, NSString *string) {
  napi_value value; napi_create_string_utf8(env, string.UTF8String, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, object, name, value);
}
static napi_value status(napi_env env, napi_callback_info info) {
  napi_value value, count;
  napi_create_object(env, &value);
  setString(env, value, "state", state); setString(env, value, "message", detail);
  if (transportError) setString(env, value, "transportError", transportError);
  napi_create_double(env, framesSent, &count); napi_set_named_property(env, value, "framesSent", count);
  napi_set_named_property(env, value, "connected", boolean(env, queue != nullptr));
  return value;
}
static napi_value activate(napi_env env, napi_callback_info info) {
  if ([state isEqualToString:@"installing"] || [state isEqualToString:@"approval"]) return status(env, info);
  if (![NSBundle.mainBundle.bundlePath hasPrefix:@"/Applications/"]) {
    state = @"location"; detail = @"Move Stipple Cam to Applications, then reopen it to enable the camera.";
    return status(env, info);
  }
  state = @"installing"; detail = @"Enabling the Stipple Cam camera extension…";
  if (!delegate) delegate = [ActivationDelegate new];
  OSSystemExtensionRequest *request = [OSSystemExtensionRequest activationRequestForExtension:@"com.tomjohn.stipplecam.camera-extension" queue:dispatch_get_main_queue()];
  request.delegate = delegate;
  [OSSystemExtensionManager.sharedManager submitRequest:request];
  return status(env, info);
}
static napi_value writeFrame(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool isBuffer = false; void *data = nullptr; size_t length = 0;
  if (argc != 1 || napi_is_buffer(env, args[0], &isBuffer) != napi_ok || !isBuffer || napi_get_buffer_info(env, args[0], &data, &length) != napi_ok || length != stipple::pixelBytes) {
    napi_throw_type_error(env, nullptr, "Expected one 1280×720 RGBA frame"); return nullptr;
  }
  if (![state isEqualToString:@"ready"] || !connectTransport()) return boolean(env, false);
  if (CMSimpleQueueGetFullness(queue) >= 1) {
    uint64_t now = stipple::now();
    if (!fullSince) fullSince = now;
    // Reconnect after a stalled extension; never keep displaying a stale frame.
    if (now - fullSince > 1000000000ULL) stopTransport();
    return boolean(env, false);
  }
  fullSince = 0;
  CVPixelBufferRef pixel = nullptr;
  NSDictionary *limits = @{ (id)kCVPixelBufferPoolAllocationThresholdKey: @6 };
  if (CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool, (__bridge CFDictionaryRef)limits, &pixel) != kCVReturnSuccess) return boolean(env, false);
  CVPixelBufferLockBaseAddress(pixel, 0);
  auto *source = static_cast<const uint8_t *>(data);
  auto *destination = static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(pixel));
  size_t stride = CVPixelBufferGetBytesPerRow(pixel);
  for (size_t y = 0; y < stipple::height; y++) {
    auto *row = destination + y * stride; const auto *input = source + y * stipple::rowBytes;
    for (size_t x = 0; x < stipple::rowBytes; x += 4) { row[x] = input[x + 2]; row[x + 1] = input[x + 1]; row[x + 2] = input[x]; row[x + 3] = 255; }
  }
  CVPixelBufferUnlockBaseAddress(pixel, 0);
  CMSampleTimingInfo timing = { CMTimeMake(1, 30), CMClockGetTime(CMClockGetHostTimeClock()), kCMTimeInvalid };
  CMSampleBufferRef sample = nullptr;
  bool ok = CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, pixel, format, &timing, &sample) == noErr;
  if (ok) { ok = CMSimpleQueueEnqueue(queue, sample) == noErr; if (!ok) CFRelease(sample); }
  CVPixelBufferRelease(pixel);
  if (ok) framesSent++;
  return boolean(env, ok);
}
static napi_value stop(napi_env env, napi_callback_info info) { stopTransport(); return boolean(env, true); }
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"activate", nullptr, activate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"status", nullptr, status, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"writeFrame", nullptr, writeFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 4, methods);
  napi_add_env_cleanup_hook(env, [](void *) { stopTransport(); }, nullptr);
  return exports;
}
NAPI_MODULE(stipple_camera, init)
