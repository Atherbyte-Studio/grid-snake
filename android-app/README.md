# Grid Snake for Android (Capacitor)

The game itself is the single file `../grid-snake.html` (built from `../src`). This folder only wraps it:
the original project is never modified. `scripts/build-www.js` copies it into `www/` with four small changes
(local fonts, viewport tag, touch polish, Android Back handler). Nothing is loaded from the internet.

```
android-app/
  capacitor.config.json   app id, name, system-bar handling
  scripts/build-www.js    ../grid-snake.html -> www/   (fails loudly if the game file changed shape)
  scripts/make-icons.py   draws the launcher icons
  assets/fonts/           Sora + Instrument Sans (SIL OFL)
  assets/play-store-icon-512.png
  android/                the native project (package com.waseem.gridsnake)
  tests/www.test.js       offline / fonts / Back button / phone-size checks on www/
  (../.github/workflows/android.yml  cloud build of the APK and AAB, at the project root)
```

## Build on your own computer (Node 22, JDK 21, Android Studio or the Android SDK)

```
cd android-app
npm install
npm test                 # needs Playwright: npm i -D playwright && npx playwright install chromium
npm run apk              # -> android/app/build/outputs/apk/debug/app-debug.apk
```
Copy the APK to the phone and open it (allow "install unknown apps" for your file manager once).
`adb install -r app-debug.apk` also works.

## Release for Google Play

1. **Make an upload key** (once; keep it and its passwords safe, losing them is painful):
   `keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`
   Put `upload.jks` in `android/`, and create `android/keystore.properties`:
   ```
   storeFile=upload.jks
   storePassword=...
   keyAlias=upload
   keyPassword=...
   ```
   Both files are git-ignored. Never share them.
2. `npm run aab` -> `android/app/build/outputs/bundle/release/app-release.aab` (signed).
3. Cloud alternative: add the secrets `GRIDSNAKE_KEYSTORE_B64` (`base64 -w0 upload.jks`), `GRIDSNAKE_STORE_PASSWORD`,
   `GRIDSNAKE_KEY_ALIAS`, `GRIDSNAKE_KEY_PASSWORD` to the GitHub repo and run the workflow.
4. Play Console: create the app, enable **Play App Signing**, upload the `.aab`, and fill in the store listing
   (use `assets/play-store-icon-512.png`; you still need a 1024x500 feature graphic and 2+ phone screenshots),
   content rating, Data safety form, target audience, and a **privacy policy URL** (required even for offline apps;
   say that all data stays on the device). New personal developer accounts must also run a closed test with
   12+ testers for 14 days before they can publish to production.
5. Before the first upload decide the package name: `com.waseem.gridsnake` is permanent once published
   (change it in `capacitor.config.json`, `android/app/build.gradle`, `strings.xml`, the Java folder and its `package` line).
   For every later upload raise `versionCode` in `android/app/build.gradle`.

## Notes
* Progress (name, coins, skins, best scores) is stored on the phone in the app's local storage. Clearing app data or
  uninstalling erases it; the in-game backup code is the way to move it. The "online copy" only exists inside claude.ai.
* Android Back: closes a dialog, leaves a run for the menu, and on the menu sends the app to the background.
