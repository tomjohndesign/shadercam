#pragma once
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#include <cstdint>
namespace stipple {
constexpr size_t width = 1280, height = 720, rowBytes = width * 4, pixelBytes = rowBytes * height;
inline uint64_t now() { return CMTimeConvertScale(CMClockGetTime(CMClockGetHostTimeClock()), 1000000000, kCMTimeRoundingMethod_Default).value; }
// Accessed only on the extension's main queue. Retains one frame, never an unbounded queue.
class LatestFrame {
  CVPixelBufferRef pixel = nullptr;
  uint64_t received = 0;
public:
  ~LatestFrame() { clear(); }
  void clear() { if (pixel) CVPixelBufferRelease(pixel); pixel = nullptr; received = 0; }
  bool accept(CMSampleBufferRef sample, uint64_t time = now()) {
    CVPixelBufferRef next = CMSampleBufferGetImageBuffer(sample);
    if (!next || CVPixelBufferGetWidth(next) != width || CVPixelBufferGetHeight(next) != height || CVPixelBufferGetPixelFormatType(next) != kCVPixelFormatType_32BGRA) return false;
    CVPixelBufferRetain(next); clear(); pixel = next; received = time; return true;
  }
  CVPixelBufferRef current(uint64_t time = now()) const { return pixel && time >= received && time - received < 500000000ULL ? pixel : nullptr; }
};
}
