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

**Want to talk in voice chat from your phone?** Browsers only allow the microphone on secure (`https://`) pages, so Vinyl also serves an https address on your Wi-Fi, which looks like `https://192-168-0-179.sslip.io:7734`. It's printed in the server window.
- Vinyl makes its own certificate for it, using the OpenSSL that comes with Git for Windows.
- The first time, the phone warns that the connection isn't private, because nobody vouches for a home-made certificate. Tap **Advanced → Proceed**.
- Room invites use this address automatically.

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

- **Private:** only people with the link can join. The link contains a long random room code. In **Room settings** you can also:
  - add a **PIN** (4–8 digits): people need it to get in. Wrong guesses are limited, so it can't be guessed by trying.
  - **lock** the room so no new people can join.
  - remove someone with the **×** next to their name.
- **You're the DJ:** listeners follow your play, pause, skip and seek. Their own play/pause only affects their own device; pressing play again re-syncs them.
- **Song requests (on by default):** listeners add songs from links, Search or their playlists, and the songs join the **end of the queue**.
  - Everyone sees "added by Riya" on them, and a note appears in the chat.
  - Each person can have **5 songs waiting** at a time; you can change that limit or switch requests off.
- **Vote to skip:** a listener pressing Next votes to skip the song. Once more than half of the listeners agree, it skips.
- **Reactions:** tap 🔥 ❤️ 😂 👏 🎉 and they float up over everyone's turntable.
- **Hand the room over:** the 👑 next to someone's name makes them the host. When you **Leave** while others are still listening, Vinyl offers to hand over so the music keeps going. If the host's connection drops for more than a minute, the room passes to someone who's still there.
- **Shared controls:** "Listeners can also skip, pause and seek" is off by default; switch it on to let everyone run the music and reorder the queue.
- **Chat:** the Room tab has a chat for everyone in the room.
- **A listener's own queue** is set aside while they're in a room and restored when they leave.

**Who can join:**
- **Same Wi-Fi:** works straight away.
- **Friends anywhere:** install Cloudflare's free `cloudflared` once with `winget install --id Cloudflare.cloudflared` and restart Vinyl. Then **Invite → Share over the internet** opens a temporary secure `https://…trycloudflare.com` link, no account needed. It closes when you turn it off or close Vinyl.
- **Your PC is the hub:** rooms run on your PC's Vinyl server and need nobody else's service, so keep Vinyl running while the room is open.

**Voice chat:** in the Room tab, tap **Join voice** to talk with everyone while the music keeps playing.
- The music dips while someone talks, and a green ring shows who's speaking.
- Mute with the mic button at the top.
- **Push to talk:** switch it on in the voice card. Your mic then only sends sound while you hold **T** or hold the mic button.
- Voices go directly between devices; Vinyl's server only helps them connect. If a connection drops, Vinyl redials automatically.
- **Headphones work best**, so the music from your speakers doesn't get picked up by your mic.
- Browsers only allow the microphone on secure (`https://`) pages. Invites use Vinyl's https Wi-Fi address (see above) or the internet link, so everyone can talk. People who open the plain `http://` link can still *hear* voice chat.
- It suits a small group of friends; everyone connects to everyone, so very big rooms get heavy.
- **Strict networks:** some offices, colleges and mobile carriers block direct connections. A **voice relay** fixes that (next section).

### Voice relay (optional): voice on any network

A TURN relay passes voices along when two devices can't reach each other directly. Vinyl works with any of these. Pick one, and only people inside a room ever receive the relay details.

1. **Metered** (free plan, simplest): sign up at metered.ca, create a TURN app, and copy the app name and API key.
2. **Cloudflare** (free tier): create a TURN key in the Cloudflare dashboard (Calls → TURN), and copy the key ID and API token.
3. **Your own TURN server** (for example coturn): its URLs, username and password.

Copy `vinyl.config.example.json` to `vinyl.config.json` and fill in the matching fields. That file stays private, because it's in `.gitignore`. You can also set them as environment variables: `METERED_APP` + `METERED_API_KEY`, or `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN`, or `TURN_URLS` + `TURN_USERNAME` + `TURN_CREDENTIAL`. Restart Vinyl; the server window says "Voice relay (TURN): configured".

**Spotify songs in a room:** each listener needs their own Spotify Premium connected to hear them. YouTube Music songs work for everyone.

## Host it in the cloud (always on, rooms without your PC)

Vinyl's server has no dependencies, so free cloud hosts can run it as-is. You get a permanent `https://` address that:
- works from anywhere with no PC running, rooms and voice chat included,
- installs as a real app on Android, iOS, Windows and macOS,
- allows Google and Spotify sign-in. Add the new address as another authorized JavaScript origin for Google, and `https://your-address/callback.html` as a Spotify redirect URI.

**Render (free):**
1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint** and pick the repo. It reads `render.yaml`.
3. Wait for the deploy and open the address it gives you.

The free plan sleeps after about 15 minutes without visitors. The first visit after that takes a moment to wake it, and any open rooms are reset.

**Fly.io or Railway:** use the included `Dockerfile`. For Fly, `fly.toml` is ready: run `fly launch --copy-config`, then `fly deploy`.

Cloud mode (`VINYL_CLOUD=1`, switched on automatically on these hosts) turns off the PC-only parts: Wi-Fi addresses, the Cloudflare quick link and the home-made certificate. To add a voice relay there, set the variables from the section above in the host's dashboard.

Just want the player without rooms? The `public/` folder also works as a plain static site (Netlify Drop, GitHub Pages, Cloudflare Pages).

## Player extras

- **Reorder the queue:** drag a song by the dotted handle, or focus the handle and press ↑/↓.
- **Synced lyrics:** the **Lyrics** tab shows the words in time with the music, from LRCLIB, a free open lyrics library. Tap a line to jump there. Songs LRCLIB doesn't know show unsynced lyrics, or a note.
- **Crossfade:** in **Settings → Playback**, blend each YouTube song into the next over 3–12 seconds. Spotify songs use the Spotify app's own crossfade setting.
- **Sleep timer:** in **Settings → Playback**, stop after 15/30/45/60 minutes or at the end of the song. The music fades out gently, and a 🌙 badge in the top bar shows the time left. Click the badge to change it.
- **Recently played:** the last 60 songs you heard, under **Library**, ready to play again.

## The deck

The screen has three parts:

1. **The turntable.** It sits in its own brushed silver box, with the song's title and seek bar below it, then five keys (Shuffle, Previous, Play, Next, Repeat) and a volume knob.
2. **The crate.** Every song in your queue is a record in it.
3. **Everything else.** Queue, Library, Search, listening rooms and Settings. On phones and tablets this part opens as a sheet from the top bar, and the crate runs along the bottom.

What each part does:

- **The crate:** hover a sleeve to pull it out and see the record inside. Click it and the record comes out, flies onto the turntable and plays. The record that's playing leaves an empty, marked sleeve behind. With an empty queue, the crate holds three demo records to try.
- **Changing songs changes the record:** the old one goes back to the crate, the new one drops onto the platter, the arm waits on its rest and then cues in.
- **The record** is pressed fresh for every song, with its own grooves, quiet bands between tracks and a matrix number in the run-out. It spins up and brakes with real weight, and the light on its grooves stays put while it turns.
- **The tonearm** follows the song like a real stylus. Pick it up and drop it anywhere on the record to jump there. The time shows where it will land. When you pause, it lifts and swings back to its rest; press play and it cues back in right where the song left off.
- **The strobe marks** on the platter rim light up near the lamp and stand still once the platter is at 33⅓.
- **The knob** is a real one: a knurled chrome skirt, a turned chrome cap, and only its white dot shows the volume. Grab it by the rim and turn it (the dot follows your finger), or pull it like a fader: up or right is louder. Press it like a button to mute (the dot goes dark).
- **The keys** are polished chrome. Like a mirror, they show a bright top, a dark horizon, and the warm room below it.
- **It's warm on purpose:** amber lamps, and a time readout that glows like an old amber display. The fire's light catches the bottom of the silver plinth. Each album still tints the accent, but always a shade of orange, from vermilion to amber.
- **No video window:** the YouTube player plays the sound out of sight, so the turntable is the only picture.

## The glow

Behind the whole app burns a fireside, drawn live with WebGL. Warm smoke rises and turns gently around the turntable, embers catch on its edges, a hearth glows behind the deck, and sparks drift up.

- **On its own** it follows the player. It's banked and quiet when nothing plays, comes alive when the music starts, gets brighter as you turn the volume up, and flares each time a record drops onto the platter or you drop the needle.
- **Let it hear the music** with the wave button at the top. Browsers don't let a page hear YouTube or Spotify directly, so Vinyl asks first:
  - **Listen to this tab** (Chrome or Edge on a computer): pick *This tab* and keep *Share tab audio* on.
  - **Use the microphone**: works when the music plays out loud, not on headphones.

  The bass makes the embers flare and the hearth thump, the mids stir the smoke, and the highs throw sparks. Nothing is recorded or sent anywhere. The sound is only measured on your device, and only while listening is on. Press the button again to stop.
- It renders at reduced resolution, drops it further on slow devices, and holds still if your system asks for reduced motion.

## Controls

| | |
|---|---|
| Click a record in the crate | put it on and play it (hover to preview) |
| Tap the record | play / pause |
| Drag the tonearm onto the record | jump to that point in the song |
| Turn the knob, or drag it up / down | volume (press it to mute, or scroll over it) |
| Swipe across the turntable | next / previous |
| `Space` | play / pause |
| `←` `→` | seek 5 s (`Shift` = prev/next track) |
| `↑` `↓` | volume |
| `N` / `P` | next / previous |
| `S` / `R` / `M` | shuffle / repeat / mute |
| `L` | open the lyrics |
| hold `T` | talk (when push to talk is on) |
| Drag a queue song's handle | reorder (or focus it and press `↑` / `↓`) |

Media keys, headphone buttons and the lock-screen player also work.

## Good to know

- Playback uses YouTube's official embedded player, so a few tracks whose owners block embedding are skipped automatically.
- On phones, mobile browsers pause YouTube when the screen locks or you switch apps. This is a browser limit, not something the app can override. Keep Vinyl in front, or use the PC as the player.
- A pasted playlist loads up to about 200 tracks. With your account connected, there is no such limit.
- Song titles for pasted playlists come from YouTube's public oEmbed endpoint, with noembed.com as a fallback. Lyrics are looked up on lrclib.net by song title and artist.
- The room server limits how fast anyone can open rooms, chat, react, vote or guess PINs, so a shared link can't be used to flood it.

## Tests

`npm test` runs the whole suite: the room server's API, the player, listening rooms with two browsers, and voice chat with Chrome's fake microphone. The browser tests drive a real Chrome with a stand-in for YouTube, so they run offline and don't depend on YouTube.

GitHub runs the same tests on every push and pull request (`.github/workflows/test.yml`), and the result shows as a ✓ or ✗ next to each commit. If Chrome isn't in a standard place, set `CHROME_PATH`.
