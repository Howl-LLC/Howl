# Google MediaPipe — Bundled Models

Howl ships these MediaPipe model files so the browser can run on-device
background segmentation (virtual backgrounds) and face landmark detection
without fetching them from a third-party CDN at runtime.

## Files

- `selfie_multiclass_256x256.tflite` — Selfie Multiclass segmentation model
- `face_landmarker.task` — Face Landmarker task bundle

## Upstream Source

These models are published by Google as part of MediaPipe Solutions:

- Image segmentation: https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter
- Face landmark detection: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker

## License

Google MediaPipe and its bundled model assets are licensed under the
Apache License 2.0. See https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE
