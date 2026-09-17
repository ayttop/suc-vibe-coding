# Robot Interaction Patterns

> **Source**: adapted from `reachy_mini/skills/interaction-patterns.md`.
> The examples are in Python; translate 1-to-1 to JS via the robot's
> state getters (`robot.getAntennas()`, `robot.getHeadPose()`) or the
> state WebSocket described in `robot-rest-api.md`.

---

## When to read this

- Designing how users will interact with the robot.
- Building games or interactive experiences.
- Creating apps **without** a traditional GUI.
- The user mentions "antenna", "joystick", "controller",
  "no UI", "physical button".

---

## Antennas as buttons

The antenna motors use a low-P PID - they're semi-passive and safe to
push. That makes them natural **physical buttons**.

```js
const ANTENNA_THRESHOLD = 0.3; // radians, tune per user

function detectAntennaPress(antennas) {
  const [left, right] = antennas;
  if (Math.abs(left) > ANTENNA_THRESHOLD) return "left";
  if (Math.abs(right) > ANTENNA_THRESHOLD) return "right";
  return null;
}

// Subscribe to state updates (SDK hook or WebSocket)
robot.on("state", (state) => {
  const press = detectAntennaPress(state.antenna_joint_positions);
  if (press && !cooldown) {
    cooldown = true;
    onAntennaPress(press);
    setTimeout(() => (cooldown = false), 300); // debounce
  }
});
```

### Use cases

- **Start / stop** - press an antenna to begin a game or round.
- **Left / right choice** - left = option A, right = option B.
- **Confirmation** - any antenna = "yes".

Reference app: `reachy_mini_radio` (changing stations via antenna press).

---

## Head as controller

The head has 6 DOF - it's a powerful input device for games, recording
or puppeteering.

```js
function headAsJoystick(headPose) {
  // Normalize yaw/pitch to [-1, 1]
  const yaw = headPose.yaw / 45.0; // assume +/- 45 deg usable range
  const pitch = headPose.pitch / 30.0; // assume +/- 30 deg usable range
  return {
    x: Math.max(-1, Math.min(1, yaw)),
    y: Math.max(-1, Math.min(1, pitch)),
  };
}

function controlLoop() {
  const joystick = headAsJoystick(robot.getHeadPose());
  updateGame(joystick);
  requestAnimationFrame(controlLoop);
}
```

### Use cases

- **Games** - head tilt controls a cursor, spaceship, character.
- **Recording** - capture head motion into a dataset or a JSON clip.
- **Puppeteering** - drive another robot or an on-screen avatar.

Reference apps: `fire_nation_attacked`, `spaceship_game`, `marionette`.

---

## No-GUI pattern

For simple apps, skip the web UI and let the robot **be** the interface.

```js
async function run() {
  // 1. Signal readiness by twitching antennas.
  await twitchAntennas(robot);

  // 2. Wait for an antenna press to start.
  const press = await waitForAntennaPress(robot);
  console.log(`Starting after ${press} antenna press`);

  // 3. Run the main loop.
  await mainLoop(robot);
}
```

### Signalling states via antennas

| State | Antenna behaviour |
|-------|-------------------|
| Ready / waiting | Gentle twitch loop. |
| Processing | Slow wave. |
| Success | Quick double bounce. |
| Error | Rapid shake. |

Reference app: `reachy_mini_simon` (full Simon-Says game using only
antennas).

---

## Combining patterns

Most interesting apps mix antenna input with head-as-joystick and/or a
`setTarget` control loop:

```js
const state = {
  mode: "waiting", // "waiting" | "playing" | "paused"
  override: null,
};

robot.on("state", (s) => {
  const press = detectAntennaPress(s.antenna_joint_positions);
  if (press === "left") state.mode = "playing";
  if (press === "right") state.mode = "paused";
});

function controlLoop() {
  const joystick = headAsJoystick(robot.getHeadPose());

  if (state.mode === "playing") {
    updateGame(joystick);
  } else if (state.mode === "paused") {
    robot.setTarget({ head: neutralPose });
  } else {
    robot.setTarget({ head: breathingPose(Date.now()) });
  }

  requestAnimationFrame(controlLoop);
}
```

---

## UX tips

- **Debounce antenna presses** - the motor has some noise. A 150-300 ms
  cooldown avoids multi-trigger.
- **Give feedback** - move antennas or play a micro-emotion when input
  is detected; users need to know you heard them.
- **Visualise thresholds** - if the user can't easily "push hard enough",
  expose the threshold in the UI.
- **Accessibility** - not every user can physically push an antenna.
  Always provide an on-screen fallback (a button that does the same).
