# Robot Overview

> **Source**: condensed from `reachy_mini/AGENTS.md` in the upstream SDK
> (pollen-robotics/reachy_mini). The Python snippets are kept for context -
> concepts map directly to the browser JS SDK (`@reachy-mini/sdk`). Read this
> chapter when the user asks about **what the robot can do** or about DOFs,
> safety, interpolation methods, motor names, etc.

---

## Hardware

| Component | Description |
|-----------|-------------|
| **Head** | 6 DOF: x, y, z, roll, pitch, yaw (via Stewart platform) |
| **Body** | Rotation around the vertical axis |
| **Antennas** | 2 motors, also usable as physical buttons |
| **Microphones** | 4-mic array with direction-of-arrival (DoA) |
| **Speaker** | Single mono speaker |
| **Camera** | One front-facing camera (streamed over WebRTC) |

**Variants:**
- **Lite** - robot tethered via USB to a laptop (full compute power).
- **Wireless** - onboard CM4, connects over WiFi (limited compute).

---

## Safety limits

Always respect these ranges. The SDK clamps automatically but your UI/UX
should match them so users don't feel the robot "stuck at a wall".

| Joint | Range |
|-------|-------|
| Head pitch / roll | [-40°, +40°] |
| Head yaw | [-180°, +180°] |
| Body yaw | [-160°, +160°] |
| Yaw delta (head - body) | Max 65° difference |

Gentle physical collisions with the body are safe. Do **not** force joints
beyond the clamped range from client code - let the SDK handle it.

---

## Motor names

When referring to individual joints (rare from the browser, but shows up in
debug logs):

```
body_rotation
stewart_1, stewart_2, stewart_3, stewart_4, stewart_5, stewart_6
right_antenna, left_antenna
```

---

## Motion model

The robot exposes two complementary motion primitives. Pick one **per
interaction**, don't mix them on the same DOF.

| Method | When | Cadence |
|--------|------|---------|
| `goto_target()` (smooth, interpolated) | Gestures, emotions, choreography, transitions. | Fire-and-forget, >= 0.5 s per call. |
| `set_target()` (immediate) | Real-time tracking, head-as-joystick, camera follow. | Continuous loop at 50-100 Hz. |

**Key insight**: during a `goto_target()` interpolation the robot is
committed to the move and **does not react to new inputs** until it ends.
For anything reactive (face tracking, games, cursor), you must run a
control loop and call `set_target()` every tick.

Interpolation methods for `goto_target`:

| Method | Character |
|--------|-----------|
| `linear` | Constant speed. |
| `minjerk` | Natural, smooth - **default**. |
| `ease_in_out` | Slow start and end. |
| `cartoon` | Exaggerated, bouncy. |

See `robot-motion.md` for the full decision tree and anti-patterns.

---

## Interaction patterns

Reachy Mini is designed to be **played with**, not just watched:

- **Antennas as buttons** - the antenna motors use a low-P PID and are safe
  to push. Poll their positions, threshold at ~0.3 rad, debounce.
- **Head as joystick** - read the head's yaw/pitch and map to a 2D input
  for games, cursors, puppeteering, recording.
- **No-GUI apps** - you don't always need a web UI. Antenna twitches can
  signal "ready", a press can start a round, antenna wave = "processing".

See `robot-interaction.md` for concrete patterns.

---

## What the daemon exposes

Every browser-based app talks to the daemon at
`http://{daemon-ip}:8000` (Lite: `localhost`, Wireless:
`reachy-mini.local`). Core surfaces:

| Surface | Used for |
|---------|----------|
| **REST / WebSocket** (`/api/*`) | Movement, state, motor mode, recorded moves. |
| **WebRTC** | Video, audio, low-latency data channel. |
| **Reachy JS SDK** (CDN) | Wraps the above with ergonomic helpers. |

For the exact endpoints and JS examples, see `robot-rest-api.md`.

---

## Example apps for inspiration

| App | Patterns |
|-----|----------|
| `reachy_mini_radio` | Change station with antennas (antenna-as-button). |
| `fire_nation_attacked`, `spaceship_game` | Head-as-joystick games. |
| `marionette` | Record & playback head motion, HF datasets. |
| `reachy_mini_simon` | No-GUI loop, antennas only. |
| `hand_tracker_v2` | Camera-driven `set_target` control loop. |
| `reachy_mini_dances_library` | Symbolic/rhythmic motion. |
| `reachy_mini_conversation_app` | Full voice conversation (Mode B). |

Most of these ship as HF Spaces - search for `reachy_mini` on the Hub.

---

## Non-negotiables for browser apps

- **Always connect through the SDK** (`new ReachyMini({ baseUrl })`). Don't
  hand-roll WebRTC signalling unless you know what you're doing.
- **Attach video BEFORE `startSession()`** - otherwise the first video
  frames are dropped and the `<video>` stays black.
- **Release the robot** on `beforeunload` / tab close. Without an explicit
  disconnect, the daemon may stay in `robot_busy` for 30 s.
- **Respect safety ranges client-side too** - reject out-of-range input
  before sending; give the user visual feedback instead of letting the
  SDK silently clamp.
