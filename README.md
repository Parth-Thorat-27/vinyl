# Vinyl

A turntable-style music player for your YouTube Music and Spotify. The record spins, the tonearm tracks the song's progress, and the whole theme re-colours itself from the album art. It runs on PC, phone and tablet.

## Start it (PC)

Double-click **`start.bat`**, or run:

```
node server.js
```

Then open **http://localhost:7733**. Keep the window open while you listen.

## Use it on your phone / tablet

1. Phone/tablet on the **same Wi-Fi** as the PC.
2. In Vinyl, open **Settings (gear) → Open on your phone or tablet** and scan the QR code. Or type the address shown in the server window, which looks like `http://192-168-0-179.sslip.io:7733`.
   - YouTube refuses to play on pages opened from a bare IP address like `http://192.168.0.179`, so Vinyl uses a free `sslip.io` name that just points back to your PC.
   - If your router blocks that, use the `.local` address printed under it.
3. The first time, Windows Firewall asks about Node.js. Allow it on **Private networks**.
4. In the phone browser menu choose **Add to Home Screen** to get an app icon.

## Add your music

**Paste links (no setup).** In YouTube Music tap **Share → Copy link** on a song, album, playlist or mix, then paste it in **Library**. Playlists are remembered under *Saved*.

**Connect your account (optional, one-time ~5 min).** This shows your own playlists and **liked songs**, and turns on **Search**. Open **Settings → Connect your YouTube account** and follow the steps there:

1. Create a Google Cloud project.
2. Enable *YouTube Data API v3*.
3. Set up the consent screen (External) and add your Gmail as a test user.
4. Create an OAuth **Web application** client with `http://localhost:7733` as an authorized JavaScript origin.
5. Paste the Client ID into Vinyl.

Access is read-only (`youtube.readonly`), and the token stays in your browser.

> Google only allows sign-in on `http://localhost` or `https://` addresses, so **account sign-in works on the PC but not over the Wi-Fi phone address**. Pasted links work everywhere. To sign in on your phone too, host the `public/` folder on free HTTPS (below).

## Connect Spotify (optional, needs Premium)

Spotify songs, albums, playlists and Liked Songs play on the same turntable, and you can mix them with YouTube Music tracks in one queue. Paste `open.spotify.com` links in **Library**, browse your playlists, or switch **Search** to Spotify.

**Setup (one-time ~5 min).** Open **Settings → Connect Spotify** and follow the steps:

1. Create an app at the Spotify Developer Dashboard. Spotify requires the app owner to have **Premium**.
2. Add the redirect URI shown in Settings, which is `http://127.0.0.1:7733/callback.html`. Spotify no longer accepts `localhost`, so Vinyl signs in through `127.0.0.1` and hops back automatically.
3. Tick **Web API** and **Web Playback SDK**, then paste the Client ID into Vinyl.

**Where the sound comes from:**
- **PC:** the browser itself becomes a Spotify device called "Vinyl".
- **Phone/tablet:** mobile browsers can't play Spotify, so Vinyl remote-controls the **Spotify app**. Open Spotify on the device first. Vinyl hands Spotify the upcoming Spotify tracks, so music keeps going even with the screen locked.
- You can pick the device under **Library → Spotify → Play on**.

**Spotify's limits for personal (Development Mode) apps:**
- Only playlists **you own or collaborate on** can be opened. Followed and editorial playlists are blocked by Spotify, so add those songs to your own playlist.
- Search returns up to 20 results.
- Spotify sign-in needs `http://127.0.0.1` (PC) or an `https://` address, so to use it on your phone, host Vinyl on HTTPS (below) and add that address's `/callback.html` as another redirect URI.

## Listen together (private rooms)

Tap the **people icon** at the top, enter your name, and **Start a room**. Then hit **Invite** and send the link (or show the QR code). Whoever opens it joins your room and hears what you play, in sync, on their own phone, tablet or PC.

- **Private:** only people with the link can join. The link contains a long random room code.
  - **Lock room** stops new people joining.
  - The **×** next to a name removes someone.
  - **End room** closes it for everyone.
- **You're the DJ:** listeners follow your play, pause, skip and seek. Their own play/pause only affects their own device; pressing play again re-syncs them.
- **Let listeners control playback and add songs:** turn this on so everyone can skip, and add songs from links, search or their playlists.
- **Chat:** the Room tab has a chat for everyone in the room.
- **A listener's own queue** is set aside while they're in a room and restored when they leave.

**Who can join:**
- **Same Wi-Fi:** works straight away.
- **Friends anywhere:** install Cloudflare's free `cloudflared` once with `winget install --id Cloudflare.cloudflared` and restart Vinyl. Then **Invite → Share over the internet** opens a temporary secure `https://…trycloudflare.com` link, no account needed. It closes when you turn it off or close Vinyl.
- **Your PC is the hub:** rooms run on your PC's Vinyl server and need nobody else's service, so keep Vinyl running while the room is open.

**Spotify songs in a room:** each listener needs their own Spotify Premium connected to hear them. YouTube Music songs work for everyone.

## Optional: host it on HTTPS (works anywhere, installable)

The `public/` folder is a plain static site. Drag it onto **https://app.netlify.com/drop**, or use GitHub Pages or Cloudflare Pages. You get an `https://…` address that:

- works away from home, with no PC running,
- installs as a real app on Android, iOS, Windows and macOS,
- allows Google and Spotify sign-in: add the new address as another authorized JavaScript origin for Google, and `https://your-site/callback.html` as a Spotify redirect URI.

## The deck

The whole screen is the turntable, built like hardware: a display, tall keys with status lights and one knob.

- **The record** is pressed fresh for every song, with its own grooves, quiet bands between tracks and a matrix number in the run-out. It spins up and brakes with real weight, and the light on its grooves stays put while it turns.
- **The tonearm** follows the song like a real stylus. Pick it up and drop it anywhere on the record to jump there. The display shows where it will land. When you pause, it lifts off the record.
- **The strobe marks** on the platter rim light up near the lamp and stand still once the platter is at 33⅓.
- **The knob** stays a plain circle until you touch it. Hold and turn for volume, tap to mute (the dot turns amber).
- **The theme** takes its colour from the album art: the label, the cartridge, the lights and the display.

## Controls

| | |
|---|---|
| Tap the record | play / pause |
| Drag the tonearm onto the record | jump to that point in the song |
| Hold and turn the knob | volume (tap it to mute, or scroll over it) |
| Swipe across the turntable | next / previous |
| `Space` | play / pause |
| `←` `→` | seek 5 s (`Shift` = prev/next track) |
| `↑` `↓` | volume |
| `N` / `P` | next / previous |
| `S` / `R` / `M` / `V` | shuffle / repeat / mute / video |

Media keys, headphone buttons and the lock-screen player also work.

## Good to know

- Playback uses YouTube's official embedded player, so a few tracks whose owners block embedding are skipped automatically.
- On phones, mobile browsers pause YouTube when the screen locks or you switch apps. This is a browser limit, not something the app can override. Keep Vinyl in front, or use the PC as the player.
- A pasted playlist loads up to about 200 tracks. With your account connected, there is no such limit.
- Song titles for pasted playlists come from YouTube's public oEmbed endpoint, with noembed.com as a fallback.
