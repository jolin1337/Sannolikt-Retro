# Sannolikt Retro Board

A collaborative whiteboard for retrospective sessions: sticky stickers, freehand drawing and
frames, edited live by everyone in the room at once.

No accounts, no database — just open a URL and start sticking.

## Features

- **Live everything.** Stickers, strokes and frames appear on every screen the moment they are
  created, moved, drawn or typed. Freehand strokes stream point-by-point while you draw.
- **One person per sticker.** Opening a sticker for editing takes an exclusive lock on it. Other
  participants see who holds it, the field goes read-only for them, and an attempt to edit shows
  "Ada is editing this". Editing a *different* sticker at the same time keeps working, and anyone
  can move a sticker nobody is holding.
- **Locks die with the person.** A lock is only live while its holder is in the room. Close a tab
  or lose the connection and the sticker is free for the next person.
- **Presence.** Every cursor carries its owner's name, and the top-right corner shows the avatar
  stack. The person editing also shows a caret inside the sticker, plus a "typing" badge.
- **Drawing and frames.** Freehand pencil strokes, draggable and resizable frames with editable
  labels, zoom-to-fit, pan and zoom, keyboard shortcuts, copy/paste and undo/redo. Frames always
  sit beneath stickers, regardless of creation order, so a frame drawn over notes never hides them.
- **Rooms.** `/r/<room>` maps to one shared document; boards are snapshotted to `data/<room>.bin`
  so content survives server restarts.

## Run

```bash
npm install
npm run build     # bundles the client into public/app.js
npm start         # http://localhost:3000
```

Open the same URL in two browser windows to collaborate. `npm run dev` runs the server with
`--watch`; `npm run watch` rebuilds the client on change.

## How it works

```
server/index.js   HTTP + Yjs websocket endpoint, room registry, snapshots
server/yjs-server.js  document rooms, sync relay, awareness relay, dead-client cleanup
server/room.js    one Y.Doc per room + persistence

src/client/entry.js   bootstrap, toolbar, join flow
src/client/board.js   tools, pointer handling, selection, locks, undo
src/client/model.js   shared document + per-element lock semantics
src/client/render.js  element + ink painting
src/client/presence.js cursors and avatars
src/client/camera.js  pan / zoom / hit coordinates
```

**Document shape.** `meta` (title, z-counter), `elements` (`id -> Y.Map` of kind `note`, `frame`
or `stroke`) and `locks` (`id -> Y.Map(claimant -> claimedAt)`). Strokes keep their points relative
to the element origin so moving one is a single x/y write. Paint and hit order come from `stackZ`:
the stored `z` counter plus a band offset that puts frames below everything else, so "bring to
front" reorders stickers among themselves without ever lifting a frame over them.

**The lock.** It is a claim, not a mutex: you write your claim, then check you won. Because
claimants live side by side in the CRDT, two people clicking at the same instant both write, and
every replica derives the same winner from identical state (earliest claim, ties broken by
clientID). The loser rolls its claim back. Locks are never persisted as authority — a claim is
real only while its author also appears in Awareness, which is why a crashed browser cannot leave
a sticker locked forever.

**Transport.** The server speaks the plain Yjs sync protocol plus awareness relays over a
websocket, so any standard Yjs client can join a room.
```
server/index.js        HTTP + websocket endpoint, room registry, snapshots
server/room.js         one Y.Doc per room, sync + awareness relay, dead-client cleanup

src/client/entry.js    bootstrap, join flow, toolbar wiring
src/client/board.js    tools, pointer handling, selection, locks, undo
src/client/model.js    shared document + per-element lock semantics
src/client/render.js   element + ink painting
src/client/presence.js cursors and avatars
src/client/camera.js   pan / zoom / hit coordinates
src/client/store.js    name + room persistence, websocket provider
```

`scripts/smoke.mjs` boots the real server and runs two Yjs clients through replication, the lock
protocol, presence, dead-peer cleanup, drawing, frames, ordering and restart persistence.
