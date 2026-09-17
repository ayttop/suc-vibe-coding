# Robot REST + WebSocket API

> **Source**: adapted from `reachy_mini/skills/rest-api.md`. Use when the
> user needs lower-level control than the JS SDK exposes (custom polling,
> direct WebSocket state streaming, MCP server bridge, etc.). For most
> apps the JS SDK (`@reachy-mini/sdk` from jsdelivr) is all you need.

---

## When to reach for the REST API

- You're controlling the robot **from a different machine** and the JS SDK
  doesn't cover your need.
- You want a **second browser tab** (dashboard, monitor) reading state
  while the main app drives the robot.
- You're building a **non-browser client** (Python, Node service, CLI).
- You want to bridge the robot into an **MCP server** for an LLM.

If you're just moving the head or streaming video inside a browser,
**stay with the JS SDK** - it handles WebRTC, session mgmt and
reconnects for you.

---

## Base URL

| Platform | URL |
|----------|-----|
| Lite (USB) | `http://localhost:8000` |
| Wireless | `http://reachy-mini.local:8000` or the robot's IP |

Interactive Swagger UI: `http://{host}:8000/docs`.

---

## Key HTTP endpoints

### Movement control

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/move/goto` | POST | Move to target (head pose, antennas, body yaw) |
| `/api/move/set_target` | POST | Set an instantaneous target (high-freq control) |
| `/api/move/play/wake_up` | POST | Wake up the robot |
| `/api/move/play/goto_sleep` | POST | Put robot to sleep |
| `/api/move/play/recorded-move-dataset/{dataset}/{move}` | POST | Play recorded moves |
| `/api/move/running` | GET | List running move tasks |
| `/api/move/stop` | POST | Stop a running move |

### State queries

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/state/full` | GET | Complete robot state |
| `/api/state/present_head_pose` | GET | Current head pose |
| `/api/state/present_body_yaw` | GET | Current body rotation |
| `/api/state/present_antenna_joint_positions` | GET | Antenna positions |
| `/api/state/doa` | GET | Direction of arrival (microphones) |

### Motor control

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/motors/status` | GET | Motor status / control mode |
| `/api/motors/set_mode/{mode}` | POST | Change mode: `enabled`, `disabled`, `gravity_compensation` |

---

## WebSocket endpoints

| Endpoint | Purpose |
|----------|---------|
| `ws://{host}:8000/api/state/ws/full` | Real-time state streaming |
| `ws://{host}:8000/api/move/ws/updates` | Movement event streaming |
| `ws://{host}:8000/api/move/ws/set_target` | Stream target commands at high cadence |

The last one is the right surface for a reactive control loop: open one
WebSocket, send pose frames at 50-100 Hz, let the daemon handle safety
clamping server-side.

---

## JavaScript examples

### Move the head via HTTP

```js
await fetch("http://localhost:8000/api/move/goto", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    head_pose: { yaw: 30, pitch: 10 },
    duration: 1.0,
  }),
});
```

### Poll current state

```js
const state = await fetch("http://localhost:8000/api/state/full").then((r) =>
  r.json(),
);
console.log(state.head_pose, state.body_yaw, state.antenna_joint_positions);
```

### Stream state over WebSocket

```js
const ws = new WebSocket("ws://localhost:8000/api/state/ws/full");
ws.onmessage = (event) => {
  const state = JSON.parse(event.data);
  // state.head_pose, state.body_yaw, state.doa, etc.
};
```

### High-frequency target stream

```js
const ws = new WebSocket("ws://localhost:8000/api/move/ws/set_target");
ws.onopen = () => {
  setInterval(() => {
    ws.send(
      JSON.stringify({
        head_pose: computeTargetHeadPose(),
        body_yaw: computeTargetBodyYaw(),
      }),
    );
  }, 20); // 50 Hz
};
```

---

## Notes for vibe-coder apps

- On a Hugging Face Space, the REST API is **not** reachable from the
  Space's browser tab because the daemon lives on the user's own machine
  / robot. The JS SDK solves this via WebRTC + OAuth; REST calls only
  work when the page is served from the same origin as the daemon.
- For a Mode A (minimal static) app you should **not** hit these
  endpoints directly - use `robot.goto()`, `robot.setTarget()`, etc.
- Use the REST API when writing a **debug tool**, a **dashboard served
  locally**, or when integrating the robot into an MCP server.
