# Amplifier: free sound amplifier for iPhone

Amplifier is a free iPhone app that boosts sound through your headphones. It works for voices, conversations, TV, lectures and music.
It is a Progressive Web App (PWA), so you install it from Safari. It needs no App Store, no account and no payment, and has no ads.
All audio is processed on your phone and nothing is uploaded.

## Features

| Feature | What it does |
|---|---|
| Live microphone amplification | Up to **+40 dB** boost, sent to wired headphones or AirPods |
| Audio file booster | Make quiet songs, videos and voice memos louder |
| 8 presets | Normal, Hearing boost, Speech, TV, Whisper, Music, Bass boost, Night |
| Custom presets | Save and delete your own presets |
| 10-band equalizer | 31 Hz – 16 kHz, ±12 dB each |
| Speech clarity | Lifts the 3 kHz range where consonants live |
| Noise reduction | Noise gate on the audio thread plus an adjustable low-cut (rumble) filter |
| Loud sound protection | Compressor plus a brick-wall limiter with an adjustable max output |
| Left/right balance | For a stronger and a weaker ear (double-tap to centre) |
| Spectrum visualizer and level meter | Shows live sound levels |
| Recorder | Record the amplified sound, play it back, share or save it to Files, and delete it. Recordings stay on the device |
| iPhone options | Echo cancellation, built-in noise suppression, auto gain, keep screen awake, mono-to-both-ears |
| Works offline | After the first open |

## Install on iPhone (free)

1. Open `https://tminov312-cyber.github.io/automatic-couscous/` in **Safari**.
2. Tap **Share** (square with ↑), then **Add to Home Screen**, then **Add**.
3. Open **Amplifier** from the Home Screen, tap **Start** and allow the microphone.

Use headphones. With the iPhone speaker the mic picks up its own output and squeals (feedback).

## Hosting it for free

GitHub Pages serves this `docs/` folder straight from the default branch.
To set it up: **Settings › Pages › Build and deployment › Source: Deploy from a branch**,
then choose **Branch: `curing-backboard`**, folder **`/docs`**, and click **Save**.
After a minute or two the app is at `https://tminov312-cyber.github.io/automatic-couscous/`.

Any other static host (Netlify, Cloudflare Pages, Vercel) also works. Upload the `docs/` folder.
It must be served over **HTTPS**, because iPhones only allow the microphone on secure pages.

## Run locally

```bash
cd docs && python3 -m http.server 8000
# open http://localhost:8000 (the microphone works on localhost)
```

The app has no build step and no dependencies. It is plain HTML, CSS and JavaScript, using the Web Audio API.

*Not a medical device. Keep the volume at a safe level.*
