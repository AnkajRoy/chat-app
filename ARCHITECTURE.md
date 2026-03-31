# StrangerChat - Complete Architecture & How It Works

## Table of Contents
1. [Project Overview](#project-overview)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [End-to-End Flow](#end-to-end-flow)
5. [Firebase Realtime Database](#firebase-realtime-database)
6. [WebRTC & PeerJS](#webrtc--peerjs)
7. [Services Deep Dive](#services-deep-dive)
8. [Components Deep Dive](#components-deep-dive)
9. [Deployment](#deployment)

---

## Project Overview

StrangerChat is an Omegle-style random video + text chat application. Two strangers are randomly matched and can communicate via live video and text messages — all peer-to-peer with no media server.

**Key Highlights:**
- No login or signup required
- Completely anonymous
- Video and audio streams go directly between users (P2P) — not through any server
- Firebase is only used for matching strangers (signaling), not for storing messages or video

---

## Tech Stack

| Technology | Purpose |
|---|---|
| **Angular 17** | Frontend framework (standalone components) |
| **PeerJS** | WebRTC library for P2P video/audio/data connections |
| **PeerJS Cloud Server** | Free signaling server to establish WebRTC connections |
| **Firebase Realtime Database** | Lobby system to match random strangers |
| **PrimeFlex** | CSS utility framework for responsive layouts |
| **PrimeIcons** | Icon library |
| **GitHub Pages** | Static site hosting |

---

## Project Structure

```
src/
├── app/
│   ├── components/
│   │   ├── landing/                 # Home page
│   │   │   ├── landing.component.ts
│   │   │   ├── landing.component.html
│   │   │   └── landing.component.scss
│   │   └── chat/                    # Video + text chat page
│   │       ├── chat.component.ts
│   │       ├── chat.component.html
│   │       └── chat.component.scss
│   ├── services/
│   │   ├── peer.service.ts          # WebRTC/PeerJS wrapper
│   │   └── matching.service.ts      # Firebase stranger matching
│   ├── app.component.ts             # Root component (just router-outlet)
│   ├── app.config.ts                # App configuration
│   └── app.routes.ts                # Route definitions
├── environments/
│   └── environment.ts               # Firebase config
├── styles.scss                      # Global styles (PrimeFlex, PrimeIcons)
└── index.html                       # Entry HTML
```

---

## End-to-End Flow

Here's what happens from the moment a user opens the app to chatting with a stranger:

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER OPENS APP                           │
│                     (Landing Page - "/")                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                     Clicks "Start Chatting"
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   CHAT PAGE INITIALIZES                         │
│                                                                 │
│  1. Firebase Realtime DB initialized (MatchingService.init())   │
│  2. Browser requests camera + mic permission                    │
│  3. Local video stream starts playing                           │
│  4. PeerJS creates a unique Peer ID via cloud server            │
│  5. Auto-starts searching for a stranger                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                    joinLobby(peerId)
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  FIREBASE MATCHING LOGIC                        │
│                                                                 │
│  Check Firebase "waiting" node:                                 │
│                                                                 │
│  IF someone is waiting:                                         │
│    ├── Pick a random waiting user                               │
│    ├── Remove them from "waiting" pool                          │
│    ├── Write our peerId to "matches/{theirPeerId}"              │
│    └── Emit matched$ with their peerId                          │
│                                                                 │
│  IF no one is waiting:                                          │
│    ├── Add ourselves to "waiting/{ourPeerId}" = true            │
│    ├── Set onDisconnect to auto-remove us                       │
│    └── Listen on "matches/{ourPeerId}" for incoming match       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                   matched$ fires with
                   stranger's peerId
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  PEERJS P2P CONNECTION                          │
│                                                                 │
│  1. Open DataConnection (text chat channel)                     │
│  2. Open MediaConnection (video/audio call)                     │
│  3. Stranger's browser answers the call                         │
│  4. Both sides receive each other's video stream                │
│  5. Status changes to "connected"                               │
│                                                                 │
│  ┌──────────┐    P2P (WebRTC)     ┌──────────┐                 │
│  │  User A  │◄───────────────────►│  User B  │                 │
│  │ (Browser)│  Video + Audio +    │ (Browser)│                 │
│  │          │  Text Messages      │          │                 │
│  └──────────┘                     └──────────┘                 │
└─────────────────────────────────────────────────────────────────┘
```

### What Happens When User Clicks "Next":
1. Current PeerJS data + media connections are closed
2. User leaves the Firebase lobby (removes waiting/match entries)
3. Re-joins the lobby to find a new stranger
4. Cycle repeats

### What Happens When User Clicks "End":
1. All PeerJS connections destroyed
2. Camera/mic streams stopped
3. Firebase lobby entries cleaned up
4. User redirected back to landing page

---

## Firebase Realtime Database

### Why Firebase?

GitHub Pages only hosts static files — it can't run a backend server. We need a shared place where two strangers can "find" each other. Firebase Realtime Database acts as a lightweight lobby/matchmaking system.

### Database Structure

```
Firebase Realtime DB
│
├── waiting/                    # Users looking for a match
│   ├── {peerId-abc}: true     # User A is waiting
│   └── {peerId-xyz}: true     # User B is waiting
│
└── matches/                    # Match notifications
    └── {peerId-abc}: "peerId-xyz"  # Tells User A to connect to User B
```

### How Matching Works (Step by Step)

**Scenario: User A joins when no one is waiting**
```
1. User A checks "waiting" node → empty
2. User A writes: waiting/peerA = true
3. User A starts listening on matches/peerA
4. User A waits...
```

**Scenario: User B joins while User A is waiting**
```
1. User B checks "waiting" node → finds peerA
2. User B removes: waiting/peerA (so no one else matches with A)
3. User B writes: matches/peerA = "peerB"
4. User B immediately connects to peerA via PeerJS
5. User A's listener on matches/peerA fires → sees "peerB"
6. User A connects to peerB via PeerJS
7. Both users are now connected P2P!
```

### Firebase Security Rules

Secured rules that restrict what users can read/write:
```json
{
  "rules": {
    "waiting": {
      "$peerId": {
        ".read": false,
        ".write": true,
        ".validate": "newData.isBoolean() || !newData.exists()"
      },
      ".read": true
    },
    "matches": {
      "$peerId": {
        ".read": true,
        ".write": true,
        ".validate": "newData.isString() || !newData.exists()"
      },
      ".read": false
    },
    "$other": {
      ".read": false,
      ".write": false
    }
  }
}
```

**What these rules enforce:**
- `waiting` — anyone can read the waiting list (needed to find matches), values must be boolean only
- `matches` — users can only read/write their own match entry, values must be strings (peer IDs) only
- `$other` — all other database paths are completely blocked
- Prevents arbitrary data injection, payload flooding, and unauthorized access

### onDisconnect Handler

```typescript
onDisconnect(waitingRef).remove();
```

This tells Firebase: "If this user's connection drops (closes tab, loses internet), automatically remove them from the waiting pool." This prevents ghost entries in the lobby.

---

## WebRTC & PeerJS

### What is WebRTC?

WebRTC (Web Real-Time Communication) is a browser API that enables peer-to-peer audio, video, and data transfer **directly between browsers** — no media server needed.

### What is PeerJS?

PeerJS simplifies WebRTC by handling:
- **Signaling** — exchanging connection info between peers (via PeerJS Cloud Server)
- **ICE/STUN/TURN** — NAT traversal to establish direct connections
- **Connection management** — easy API for calls and data channels

### How WebRTC Connection is Established

```
┌──────────┐         PeerJS Cloud         ┌──────────┐
│  User A  │◄──────── Server ────────────►│  User B  │
│          │     (Signaling only)          │          │
└────┬─────┘                              └─────┬────┘
     │                                          │
     │  1. User A creates Peer → gets peerIdA   │
     │  2. User B creates Peer → gets peerIdB   │
     │                                          │
     │  3. User A calls peer.connect(peerIdB)   │
     │     and peer.call(peerIdB, localStream)  │
     │                                          │
     │  4. PeerJS Cloud relays the offer/answer │
     │     (SDP exchange via signaling server)   │
     │                                          │
     │  5. STUN servers help find public IPs     │
     │     (stun.l.google.com:19302)            │
     │                                          │
     │  6. Direct P2P connection established!    │
     │◄────────────────────────────────────────►│
     │     Video + Audio + Text (direct)        │
     │     No server in between!                │
```

### Two Types of PeerJS Connections

**1. MediaConnection (Video/Audio)**
```typescript
// Caller side
const mediaConn = this.peer.call(remotePeerId, this.localStream);
mediaConn.on('stream', (remoteStream) => { /* show stranger's video */ });

// Receiver side
this.peer.on('call', (call) => {
  call.answer(this.localStream);  // send our video back
  call.on('stream', (remoteStream) => { /* show stranger's video */ });
});
```

**2. DataConnection (Text Chat)**
```typescript
// Open a data channel
const dataConn = this.peer.connect(remotePeerId, { reliable: true });

// Send text
dataConn.send("Hello stranger!");

// Receive text
dataConn.on('data', (data) => { /* display message */ });
```

### ICE Servers Configuration

```typescript
config: {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
}
```

**STUN servers** help peers discover their public IP addresses so they can establish a direct connection even behind NAT/firewalls. Google provides free STUN servers.

---

## Services Deep Dive

### PeerService (`src/app/services/peer.service.ts`)

Wraps all PeerJS/WebRTC functionality.

**Key Properties (Observables):**
| Observable | Type | Purpose |
|---|---|---|
| `peerId$` | `BehaviorSubject<string>` | Our unique PeerJS ID |
| `remoteStream$` | `BehaviorSubject<MediaStream>` | Stranger's video/audio stream |
| `messages$` | `BehaviorSubject<ChatMessage[]>` | All chat messages |
| `connectionStatus$` | `BehaviorSubject` | 'disconnected' / 'connecting' / 'connected' |
| `peerDisconnected$` | `Subject<void>` | Fires when stranger disconnects |

**Key Methods:**
| Method | What it does |
|---|---|
| `initPeer()` | Creates PeerJS instance, gets unique ID from cloud server |
| `getLocalStream()` | Requests camera + mic from browser |
| `connectToPeer(id)` | Opens data + media connection to a matched stranger |
| `sendMessage(text)` | Sends text via data channel |
| `toggleAudio(bool)` | Mutes/unmutes microphone |
| `toggleVideo(bool)` | Enables/disables camera |
| `disconnect()` | Closes current connections (for "Next" button) |
| `destroy()` | Stops all streams and destroys peer (for "End" button) |

### MatchingService (`src/app/services/matching.service.ts`)

Handles the Firebase lobby/matchmaking system.

**Key Methods:**
| Method | What it does |
|---|---|
| `init()` | Initializes Firebase app and gets database reference |
| `joinLobby(peerId)` | Adds user to waiting pool or matches with existing user |
| `leaveLobby()` | Removes user from waiting pool and match entries |

**`matched$` Subject** — Emits the stranger's PeerJS ID when a match is found. The ChatComponent subscribes to this and calls `peerService.connectToPeer()`.

---

## Components Deep Dive

### LandingComponent (`/`)

Simple landing page with:
- App branding (StrangerChat logo + name)
- Feature highlights (Video Chat, Text Chat, Random Match)
- "Start Chatting" button → navigates to `/chat`

### ChatComponent (`/chat`)

The main chat interface. Handles the entire lifecycle:

**Initialization (`ngOnInit`):**
1. Init Firebase → Get camera/mic → Init PeerJS → Auto-search for stranger

**Template Layout:**
```
┌──────────────────────────────────────────────────┐
│  Header (logo + connection status badge)          │
├────────────────────────────────┬─────────────────┤
│                                │                 │
│   Stranger's Video             │   Text Chat     │
│   (large panel)                │   Messages      │
│                                │                 │
│ ┌────────────┐                 │                 │
│ │ Your Video │                 │  [input + send] │
│ │ (small)    │                 │                 │
│ └────────────┘                 │                 │
├────────────────────────────────┴─────────────────┤
│  Controls: [Mute] [Camera] [Next] [End]          │
└──────────────────────────────────────────────────┘
```

**Controls:**
- **Mute** — toggles microphone on/off
- **Camera** — toggles video on/off
- **Next** — disconnects current stranger, searches for new one
- **End** — stops everything, returns to landing page

---

## Deployment

### GitHub Pages Setup

The app is deployed as a static site on GitHub Pages.

**Build Command:**
```bash
ng build --base-href /chat-app/
```

The `--base-href /chat-app/` is required because GitHub Pages serves the site at `https://username.github.io/chat-app/`, not at the root.

**SPA Routing Fix:**
A `404.html` file (copy of `index.html`) is added to the build output. When GitHub Pages encounters a route like `/chat-app/chat`, it would normally return a 404. The custom `404.html` loads Angular, which then handles the route client-side.

**Deploy Command:**
```bash
npx angular-cli-ghpages --dir=dist/chat-app/browser
```

This pushes the build output to the `gh-pages` branch of the repository.

**Live URL:** `https://ankajroy.github.io/chat-app/`

### Architecture Diagram (Deployment)

```
┌─────────────┐     Static Files      ┌──────────────────┐
│   Browser    │◄─────────────────────►│  GitHub Pages    │
│  (Angular)   │   HTML/JS/CSS only    │  (Static Host)   │
└──────┬───────┘                       └──────────────────┘
       │
       │  Signaling (find peer IDs)
       ├──────────────────────────────►  PeerJS Cloud Server
       │
       │  Lobby/Matching
       ├──────────────────────────────►  Firebase Realtime DB
       │
       │  NAT Traversal
       ├──────────────────────────────►  Google STUN Servers
       │
       │  Direct P2P (video + text)
       ◄─────────────────────────────►  Other User's Browser
```

**Important:** No video or text data passes through any server. All media and messages flow directly between the two browsers via WebRTC. The servers (Firebase, PeerJS Cloud, STUN) are only used briefly to establish the connection.

---

## Summary of Data Flow

| Data | Where it goes | Server involved? |
|---|---|---|
| Waiting/matching status | Firebase Realtime DB | Yes (Firebase) |
| Peer ID exchange | PeerJS Cloud Server | Yes (signaling only) |
| ICE candidates | Google STUN servers | Yes (NAT traversal) |
| Video/Audio streams | Direct P2P between browsers | **No** |
| Text messages | Direct P2P between browsers | **No** |

This architecture ensures minimal server dependency, maximum privacy, and zero hosting cost.
