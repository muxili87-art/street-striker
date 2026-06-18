import Phaser from "phaser";
import "./style.css";

const WIDTH = 1280;
const HEIGHT = 720;
const FIELD = {
  left: 56,
  right: 1224,
  top: 48,
  bottom: 672,
  centerX: 640,
  centerY: 360,
  goalTop: 260,
  goalBottom: 460
};

type Side = "home" | "away";
type Role = "striker" | "wing" | "defender" | "keeper";

type PlayerAgent = {
  id: string;
  side: Side;
  role: Role;
  sprite: Phaser.Physics.Arcade.Image;
  shadow: Phaser.GameObjects.Ellipse;
  speed: number;
  kickCooldown: number;
};

type ReplayFrame = {
  ball: { x: number; y: number; rotation: number };
  players: Array<{ id: string; x: number; y: number }>;
};

type ReplayState = {
  phase: "goal" | "sideline" | "ball";
  frames: ReplayFrame[];
  elapsed: number;
  frameCursor: number;
  frameAccumulator: number;
  scoringSide: Side;
};

class SoundBoard {
  private context?: AudioContext;
  private muted = false;

  unlock() {
    if (!this.context) this.context = new AudioContext();
    void this.context.resume();
  }

  toggle() {
    this.muted = !this.muted;
    return this.muted;
  }

  kick(power = 1) {
    this.tone(105 + power * 20, 0.055, "square", 0.035);
    this.noise(0.045, 0.018);
  }

  whistle() {
    this.tone(1220, 0.11, "sine", 0.028);
    window.setTimeout(() => this.tone(1540, 0.14, "sine", 0.025), 90);
  }

  goal() {
    [392, 523, 659, 784].forEach((frequency, index) => {
      window.setTimeout(() => this.tone(frequency, 0.2, "sawtooth", 0.032), index * 85);
    });
  }

  private tone(frequency: number, duration: number, type: OscillatorType, volume: number) {
    if (!this.context || this.muted) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + duration);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start();
    oscillator.stop(this.context.currentTime + duration);
  }

  private noise(duration: number, volume: number) {
    if (!this.context || this.muted) return;
    const size = Math.floor(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, size, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < size; index += 1) data[index] = Math.random() * 2 - 1;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    gain.gain.setValueAtTime(volume, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + duration);
    source.connect(gain).connect(this.context.destination);
    source.start();
  }
}

class InputController {
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd?: Record<string, Phaser.Input.Keyboard.Key>;
  private buttons?: Record<string, Phaser.Input.Keyboard.Key>;
  private pointerVector = new Phaser.Math.Vector2(0, 0);
  private shootQueued = false;
  private passQueued = false;
  private dashDown = false;
  private pauseQueued = false;
  private stickPointerId: number | null = null;
  private readonly stickBase = document.querySelector<HTMLDivElement>("#stickBase");
  private readonly stickKnob = document.querySelector<HTMLDivElement>("#stickKnob");

  bind(scene: Phaser.Scene) {
    this.cursors = scene.input.keyboard?.createCursorKeys();
    this.wasd = scene.input.keyboard?.addKeys("W,A,S,D") as Record<string, Phaser.Input.Keyboard.Key>;
    this.buttons = scene.input.keyboard?.addKeys("SPACE,J,Q,E,SHIFT,P,K") as Record<
      string,
      Phaser.Input.Keyboard.Key
    >;

    this.bindButton("#shootButton", "shootQueued");
    this.bindButton("#passButton", "passQueued");
    this.bindButton("#dashButton", "dashDown", true);
    this.bindStick();
  }

  getMoveVector() {
    const vector = new Phaser.Math.Vector2(this.pointerVector.x, this.pointerVector.y);
    if (this.cursors?.left.isDown || this.wasd?.A.isDown) vector.x -= 1;
    if (this.cursors?.right.isDown || this.wasd?.D.isDown) vector.x += 1;
    if (this.cursors?.up.isDown || this.wasd?.W.isDown) vector.y -= 1;
    if (this.cursors?.down.isDown || this.wasd?.S.isDown) vector.y += 1;
    if (vector.lengthSq() > 1) vector.normalize();
    return vector;
  }

  consumeShoot() {
    const keyboard = this.justDown(this.buttons?.SPACE) || this.justDown(this.buttons?.E);
    const queued = this.shootQueued;
    this.shootQueued = false;
    return keyboard || queued;
  }

  consumePass() {
    const keyboard = this.justDown(this.buttons?.J) || this.justDown(this.buttons?.Q);
    const queued = this.passQueued;
    this.passQueued = false;
    return keyboard || queued;
  }

  isDashDown() {
    return Boolean(this.buttons?.SHIFT.isDown || this.dashDown);
  }

  consumePause() {
    const keyboard = this.justDown(this.buttons?.P);
    const queued = this.pauseQueued;
    this.pauseQueued = false;
    return keyboard || queued;
  }

  private justDown(key?: Phaser.Input.Keyboard.Key) {
    return key ? Phaser.Input.Keyboard.JustDown(key) : false;
  }

  private bindButton(selector: string, flag: "shootQueued" | "passQueued" | "dashDown", hold = false) {
    const button = document.querySelector<HTMLButtonElement>(selector);
    if (!button) return;

    const down = (event: PointerEvent) => {
      event.preventDefault();
      button.classList.add("is-down");
      this[flag] = true;
    };
    const up = (event: PointerEvent) => {
      event.preventDefault();
      button.classList.remove("is-down");
      if (hold) this[flag] = false;
    };

    button.addEventListener("pointerdown", down);
    button.addEventListener("pointerup", up);
    button.addEventListener("pointercancel", up);
    button.addEventListener("pointerleave", up);
  }

  private bindStick() {
    if (!this.stickBase || !this.stickKnob) return;

    const update = (event: PointerEvent) => {
      if (this.stickPointerId !== event.pointerId) return;
      const rect = this.stickBase!.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const max = rect.width * 0.34;
      const dx = Phaser.Math.Clamp(event.clientX - centerX, -max, max);
      const dy = Phaser.Math.Clamp(event.clientY - centerY, -max, max);
      this.pointerVector.set(dx / max, dy / max);
      this.stickKnob!.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    };

    const reset = (event: PointerEvent) => {
      if (this.stickPointerId !== event.pointerId) return;
      this.stickPointerId = null;
      this.pointerVector.set(0, 0);
      this.stickKnob!.style.transform = "translate(-50%, -50%)";
    };

    this.stickBase.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.stickPointerId = event.pointerId;
      this.stickBase!.setPointerCapture(event.pointerId);
      update(event);
    });
    this.stickBase.addEventListener("pointermove", update);
    this.stickBase.addEventListener("pointerup", reset);
    this.stickBase.addEventListener("pointercancel", reset);
  }
}

class StreetStrikerScene extends Phaser.Scene {
  private inputController = new InputController();
  private soundBoard = new SoundBoard();
  private players: PlayerAgent[] = [];
  private playerGroup?: Phaser.Physics.Arcade.Group;
  private ball?: Phaser.Physics.Arcade.Image;
  private ballShadow?: Phaser.GameObjects.Ellipse;
  private ballGlow?: Phaser.GameObjects.Ellipse;
  private controlledMarker?: Phaser.GameObjects.Container;
  private cameraFocus?: Phaser.GameObjects.Zone;
  private particles?: Phaser.GameObjects.Particles.ParticleEmitter;
  private replayFrames: ReplayFrame[] = [];
  private replayState?: ReplayState;
  private replayRecordAccumulator = 0;
  private replayCameraRotation = 0;
  private scrumTimer = 0;
  private scrumCooldown = 0;
  private scrumReleaseCount = 0;
  private passReceiverId?: string;
  private passWindow = 0;
  private aiActionCooldown = 0;
  private aiPassCount = 0;
  private aiShotCount = 0;
  private homeScore = 0;
  private awayScore = 0;
  private matchTime = 90;
  private stamina = 100;
  private spark = 1;
  private resetDelay = 0;
  private started = false;
  private matchOver = false;
  private pausedByPlayer = false;
  private messageUntil = 0;
  private readonly hud = {
    homeScore: document.querySelector("#homeScore"),
    awayScore: document.querySelector("#awayScore"),
    clock: document.querySelector("#clock"),
    stamina: document.querySelector("#stamina"),
    staminaFill: document.querySelector<HTMLElement>("#staminaFill"),
    spark: document.querySelector("#spark"),
    message: document.querySelector("#message"),
    cameraMode: document.querySelector("#cameraMode"),
    replayBadge: document.querySelector("#replayBadge"),
    goalOverlay: document.querySelector("#goalOverlay"),
    app: document.querySelector("#app")
  };

  constructor() {
    super("street-striker");
  }

  preload() {
    this.makeTextures();
  }

  create() {
    this.physics.world.setBounds(FIELD.left - 20, FIELD.top - 20, FIELD.right - FIELD.left + 40, FIELD.bottom - FIELD.top + 40);
    this.inputController.bind(this);
    this.drawField();
    this.createBall();
    this.createPlayers();
    this.createControlledMarker();
    this.createParticles();
    this.setupCamera();
    document.addEventListener("street-striker:start", this.beginMatch);
    document.addEventListener("street-striker:mute", this.toggleMute);
    if (import.meta.env.DEV) {
      this.input.keyboard?.on("keydown-K", this.triggerDebugReplay);
      this.installQaControls();
    }
    this.showMessage("抢球，传球，找角度射门", 2600);
    this.updateHud();
  }

  update(_time: number, deltaMs: number) {
    const safeDeltaMs = Math.min(deltaMs, 50);
    const dt = safeDeltaMs / 1000;
    if (!this.ball || !this.playerGroup) return;

    if (!this.started) {
      this.physics.world.pause();
      this.updatePresentation(dt);
      this.updateHud();
      return;
    }

    if (this.replayState) {
      this.updateReplay(Math.min(deltaMs, 1000));
      this.updatePresentation(dt);
      this.updateHud();
      return;
    }

    if (this.inputController.consumePause()) {
      this.pausedByPlayer = !this.pausedByPlayer;
      this.showMessage(this.pausedByPlayer ? "暂停" : "继续比赛", 1200);
    }
    if (this.pausedByPlayer) {
      this.physics.world.pause();
      this.updateHud();
      return;
    }
    this.physics.world.resume();

    if (this.resetDelay > 0) {
      this.resetDelay -= dt;
      this.slowBall();
      this.updateHud();
      return;
    }

    this.matchTime = Math.max(0, this.matchTime - dt);
    if (this.matchTime <= 0) {
      this.finishMatch();
      this.updateHud();
      return;
    }

    this.updateCooldowns(dt);
    this.passWindow = Math.max(0, this.passWindow - dt);
    this.aiActionCooldown = Math.max(0, this.aiActionCooldown - dt);
    if (this.passWindow <= 0) this.passReceiverId = undefined;
    this.updateUser(dt);
    this.updateAi(dt);
    this.slowBall();
    this.resolveBallScrum(dt);
    this.keepPlayersInField();
    this.recordReplayFrame(safeDeltaMs);
    this.checkGoals();
    this.updatePresentation(dt);
    this.updateHud();
  }

  private makeTextures() {
    this.makeCircleTexture("home", 42, 0x64e086, 0x0d2b18);
    this.makeCircleTexture("home-keeper", 44, 0x3fb2ff, 0x071a22);
    this.makeCircleTexture("away", 42, 0xffcf5a, 0x392308);
    this.makeCircleTexture("away-keeper", 44, 0xff6c67, 0x2b0d0d);
    this.makeCircleTexture("ball", 24, 0xf4fbf5, 0x222222);
    this.makeCircleTexture("spark", 10, 0xffffff, 0x64e086);
  }

  private makeCircleTexture(key: string, size: number, fill: number, stroke: number) {
    const graphics = this.make.graphics({ x: 0, y: 0 }, false);
    graphics.fillStyle(fill, 1);
    graphics.lineStyle(Math.max(3, size * 0.08), stroke, 1);
    graphics.fillCircle(size / 2, size / 2, size / 2 - 4);
    graphics.strokeCircle(size / 2, size / 2, size / 2 - 4);
    if (key === "ball") {
      graphics.lineStyle(2, 0x1f2a24, 0.85);
      graphics.beginPath();
      graphics.moveTo(size * 0.28, size * 0.5);
      graphics.lineTo(size * 0.72, size * 0.5);
      graphics.moveTo(size * 0.5, size * 0.28);
      graphics.lineTo(size * 0.5, size * 0.72);
      graphics.strokePath();
    }
    graphics.generateTexture(key, size, size);
    graphics.destroy();
  }

  private drawField() {
    const g = this.add.graphics();
    g.fillStyle(0x061b14, 1);
    g.fillRect(0, 0, WIDTH, HEIGHT);

    g.fillStyle(0x102d24, 1);
    g.fillRect(0, 0, WIDTH, 38);
    g.fillRect(0, HEIGHT - 38, WIDTH, 38);
    for (let x = 18; x < WIDTH; x += 34) {
      g.fillStyle(x % 68 === 18 ? 0x64e086 : 0xffcf5a, 0.34);
      g.fillCircle(x, 19, 4);
      g.fillCircle(WIDTH - x, HEIGHT - 19, 4);
    }

    for (let i = 0; i < 9; i += 1) {
      g.fillStyle(i % 2 === 0 ? 0x0d6337 : 0x09522d, 1);
      g.fillRect(FIELD.left + i * 130, FIELD.top, 130, FIELD.bottom - FIELD.top);
    }

    for (let y = FIELD.top + 28; y < FIELD.bottom; y += 54) {
      g.lineStyle(1, 0xffffff, 0.025);
      g.lineBetween(FIELD.left, y, FIELD.right, y);
    }

    g.lineStyle(4, 0xe8fff0, 0.72);
    g.strokeRect(FIELD.left, FIELD.top, FIELD.right - FIELD.left, FIELD.bottom - FIELD.top);
    g.lineBetween(FIELD.centerX, FIELD.top, FIELD.centerX, FIELD.bottom);
    g.strokeCircle(FIELD.centerX, FIELD.centerY, 88);
    g.strokeRect(FIELD.left, 220, 150, 280);
    g.strokeRect(FIELD.right - 150, 220, 150, 280);
    g.strokeRect(FIELD.left - 28, FIELD.goalTop, 28, FIELD.goalBottom - FIELD.goalTop);
    g.strokeRect(FIELD.right, FIELD.goalTop, 28, FIELD.goalBottom - FIELD.goalTop);

    g.fillStyle(0xffffff, 0.9);
    g.fillCircle(FIELD.centerX, FIELD.centerY, 5);
    g.fillCircle(FIELD.left + 105, FIELD.centerY, 4);
    g.fillCircle(FIELD.right - 105, FIELD.centerY, 4);

    this.add.rectangle(FIELD.left - 12, FIELD.centerY, 20, 190, 0xffcf5a, 0.18);
    this.add.rectangle(FIELD.right + 12, FIELD.centerY, 20, 190, 0x64e086, 0.18);
  }

  private createBall() {
    this.ballShadow = this.add.ellipse(FIELD.centerX + 5, FIELD.centerY + 8, 27, 15, 0x02120c, 0.42);
    this.ballShadow.setDepth(2);
    this.ballGlow = this.add.ellipse(FIELD.centerX, FIELD.centerY, 36, 36, 0xffffff, 0.08);
    this.ballGlow.setDepth(3);
    this.ball = this.physics.add.image(FIELD.centerX, FIELD.centerY, "ball");
    this.ball.setCircle(11);
    this.ball.setBounce(0.86);
    this.ball.setCollideWorldBounds(true);
    this.ball.setMaxVelocity(780, 780);
  }

  private createPlayers() {
    this.playerGroup = this.physics.add.group();
    const spawn: Array<[string, Side, Role, number, number]> = [
      ["you", "home", "striker", 360, FIELD.centerY],
      ["h-wing", "home", "wing", 275, 238],
      ["h-def", "home", "defender", 238, 482],
      ["h-keeper", "home", "keeper", 92, FIELD.centerY],
      ["a-striker", "away", "striker", 918, 236],
      ["a-wing", "away", "wing", 940, 484],
      ["a-def", "away", "defender", 1056, FIELD.centerY],
      ["a-keeper", "away", "keeper", 1188, FIELD.centerY]
    ];

    spawn.forEach(([id, side, role, x, y]) => {
      const texture = role === "keeper" ? `${side}-keeper` : side;
      const shadow = this.add.ellipse(x + 5, y + 10, role === "keeper" ? 42 : 39, 20, 0x02120c, 0.38);
      shadow.setDepth(3);
      const sprite = this.physics.add.image(x, y, texture);
      sprite.setCircle(role === "keeper" ? 20 : 19);
      sprite.setCollideWorldBounds(true);
      sprite.setDamping(true);
      sprite.setDrag(720, 720);
      sprite.setMaxVelocity(430, 430);
      sprite.setDepth(role === "keeper" ? 4 : 5);
      this.playerGroup!.add(sprite);
      this.players.push({
        id,
        side,
        role,
        sprite,
        shadow,
        speed: role === "keeper" ? 250 : 320,
        kickCooldown: 0
      });
    });

    this.physics.add.collider(this.playerGroup, this.playerGroup);
    this.physics.add.collider(this.playerGroup, this.ball!, (_player, ballObject) => {
      const ball = ballObject as Phaser.Physics.Arcade.Image;
      const body = ball.body as Phaser.Physics.Arcade.Body;
      body.velocity.scale(body.velocity.length() < 220 ? 0.76 : 0.98);
    });
  }

  private createControlledMarker() {
    const user = this.players.find((player) => player.id === "you");
    if (!user) return;
    const ring = this.add.ellipse(0, 7, 62, 34).setStrokeStyle(4, 0xffffff, 0.95);
    const inner = this.add.ellipse(0, 7, 49, 25).setStrokeStyle(2, 0x64e086, 0.9);
    const arrow = this.add.triangle(0, -40, -9, -10, 9, -10, 0, 4, 0xffffff, 1);
    const label = this.add
      .text(0, -62, "YOU", {
        fontFamily: "Arial Black, Arial, sans-serif",
        fontSize: "16px",
        color: "#ffffff",
        stroke: "#062014",
        strokeThickness: 5
      })
      .setOrigin(0.5);
    this.controlledMarker = this.add.container(user.sprite.x, user.sprite.y, [ring, inner, arrow, label]);
    this.controlledMarker.setDepth(18);
    this.tweens.add({
      targets: [ring, inner],
      scaleX: 1.12,
      scaleY: 1.12,
      alpha: 0.48,
      duration: 720,
      yoyo: true,
      repeat: -1,
      ease: "Sine.InOut"
    });
    this.tweens.add({
      targets: arrow,
      y: -35,
      duration: 520,
      yoyo: true,
      repeat: -1,
      ease: "Sine.InOut"
    });
  }

  private setupCamera() {
    this.cameraFocus = this.add.zone(FIELD.centerX, FIELD.centerY, 1, 1);
    const camera = this.cameras.main;
    camera.setBounds(0, 0, WIDTH, HEIGHT);
    camera.setZoom(1.08);
    camera.startFollow(this.cameraFocus, false, 0.08, 0.08);
    camera.setDeadzone(120, 80);
  }

  private createParticles() {
    this.particles = this.add.particles(0, 0, "spark", {
      lifespan: 300,
      speed: { min: 30, max: 120 },
      scale: { start: 1, end: 0 },
      alpha: { start: 0.55, end: 0 },
      quantity: 0,
      emitting: false
    });
    this.particles.setDepth(2);
  }

  private updateCooldowns(dt: number) {
    for (const player of this.players) {
      player.kickCooldown = Math.max(0, player.kickCooldown - dt);
    }
  }

  private beginMatch = () => {
    if (this.matchOver || this.matchTime <= 0) {
      this.homeScore = 0;
      this.awayScore = 0;
      this.matchTime = 90;
      this.stamina = 100;
      this.spark = 1;
      this.resetDelay = 0;
      this.resetPositions();
    }
    this.started = true;
    this.matchOver = false;
    this.pausedByPlayer = false;
    this.soundBoard.unlock();
    this.soundBoard.whistle();
    this.physics.world.resume();
    this.restoreMatchCamera(true);
    this.showMessage("开球！抢节奏", 1200);
  };

  private triggerDebugReplay = () => {
    if (!this.started || this.replayState || this.matchOver || !this.ball) return;
    const startX = this.ball.x;
    const startY = this.ball.y;
    const playerStates = this.players.map((player) => ({
      id: player.id,
      x: player.sprite.x,
      y: player.sprite.y
    }));
    this.replayFrames = Array.from({ length: 48 }, (_, index) => {
      const progress = index / 47;
      return {
        ball: {
          x: Phaser.Math.Linear(startX, FIELD.right - 2, progress),
          y: startY + Math.sin(progress * Math.PI) * 42,
          rotation: progress * Math.PI * 5
        },
        players: playerStates.map((player) => ({ ...player }))
      };
    });
    this.ball.setPosition(FIELD.right - 2, startY);
    this.homeScore += 1;
    this.afterGoal("进球镜头测试", "home");
  };

  private installQaControls() {
    if (!new URLSearchParams(window.location.search).has("qa")) return;
    if (document.querySelector("#qaReplayButton")) return;
    const button = document.createElement("button");
    button.id = "qaReplayButton";
    button.className = "qa-replay-button";
    button.type = "button";
    button.textContent = "TEST REPLAY";
    button.addEventListener("click", this.triggerDebugReplay);
    document.body.append(button);

    const nextButton = document.createElement("button");
    nextButton.id = "qaNextCameraButton";
    nextButton.className = "qa-replay-button qa-next-button";
    nextButton.type = "button";
    nextButton.textContent = "NEXT CAMERA";
    nextButton.addEventListener("click", this.advanceQaReplay);
    document.body.append(nextButton);

    const scrumButton = document.createElement("button");
    scrumButton.id = "qaScrumButton";
    scrumButton.className = "qa-replay-button qa-scrum-button";
    scrumButton.type = "button";
    scrumButton.textContent = "TEST SCRUM";
    scrumButton.addEventListener("click", this.triggerQaScrum);
    document.body.append(scrumButton);

    const pressureButton = document.createElement("button");
    pressureButton.id = "qaPressureButton";
    pressureButton.className = "qa-replay-button qa-pressure-button";
    pressureButton.type = "button";
    pressureButton.textContent = "TEST AI PRESS";
    pressureButton.addEventListener("click", this.triggerQaPressure);
    document.body.append(pressureButton);

    const teamButton = document.createElement("button");
    teamButton.id = "qaTeamButton";
    teamButton.className = "qa-replay-button qa-team-button";
    teamButton.type = "button";
    teamButton.textContent = "TEST TEAM RUN";
    teamButton.addEventListener("click", this.triggerQaTeamRun);
    document.body.append(teamButton);

    const keysButton = document.createElement("button");
    keysButton.id = "qaKeysButton";
    keysButton.className = "qa-replay-button qa-keys-button";
    keysButton.type = "button";
    keysButton.textContent = "TEST KEYS";
    keysButton.addEventListener("click", this.triggerQaKeys);
    document.body.append(keysButton);

    const passingButton = document.createElement("button");
    passingButton.id = "qaPassingButton";
    passingButton.className = "qa-replay-button qa-passing-button";
    passingButton.type = "button";
    passingButton.textContent = "TEST PASS PLAY";
    passingButton.addEventListener("click", this.triggerQaPassing);
    document.body.append(passingButton);

    const finishButton = document.createElement("button");
    finishButton.id = "qaFinishButton";
    finishButton.className = "qa-replay-button qa-finish-button";
    finishButton.type = "button";
    finishButton.textContent = "TEST AI FINISH";
    finishButton.addEventListener("click", this.triggerQaFinish);
    document.body.append(finishButton);
  }

  private triggerQaScrum = () => {
    if (!this.started || !this.ball || this.replayState) return;
    this.ball.setPosition(FIELD.centerX, FIELD.centerY);
    this.ball.setVelocity(0, 0);
    const crowd = this.players.filter((player) => player.side === "away").slice(0, 3);
    const positions = [
      [FIELD.centerX - 34, FIELD.centerY],
      [FIELD.centerX + 30, FIELD.centerY - 20],
      [FIELD.centerX + 28, FIELD.centerY + 24]
    ];
    crowd.forEach((player, index) => {
      player.sprite.setPosition(positions[index][0], positions[index][1]);
      player.sprite.setVelocity(0, 0);
      player.kickCooldown = 2;
    });
    const user = this.players.find((player) => player.id === "you");
    user?.sprite.setPosition(FIELD.centerX - 180, FIELD.centerY);
    this.scrumTimer = 0;
    this.scrumCooldown = 0;
    this.showMessage("测试：三人围抢", 900);
  };

  private triggerQaPressure = () => {
    if (!this.started || !this.ball || this.replayState) return;
    this.ball.setPosition(390, FIELD.centerY);
    this.ball.setVelocity(0, 0);
    for (const player of this.players) {
      if (player.side === "away") {
        player.sprite.setPosition(
          player.role === "keeper" ? 1188 : player.role === "defender" ? 930 : 820,
          player.role === "striker" ? 250 : player.role === "wing" ? 470 : FIELD.centerY
        );
        player.sprite.setVelocity(0, 0);
        player.kickCooldown = 3;
      }
    }
    const user = this.players.find((player) => player.id === "you");
    user?.sprite.setPosition(260, 560);
    this.scrumCooldown = 2;
    this.showMessage("测试：对手越过中线压迫", 1200);
  };

  private triggerQaTeamRun = () => {
    if (!this.started || !this.ball || this.replayState) return;
    this.ball.setPosition(835, FIELD.centerY);
    this.ball.setVelocity(0, 0);
    for (const player of this.players) {
      if (player.side === "home" && player.id !== "you") {
        player.sprite.setPosition(
          player.role === "keeper" ? 92 : player.role === "wing" ? 420 : 340,
          player.role === "wing" ? 230 : player.role === "defender" ? 490 : FIELD.centerY
        );
        player.sprite.setVelocity(0, 0);
        player.kickCooldown = 3;
      }
    }
    const user = this.players.find((player) => player.id === "you");
    user?.sprite.setPosition(700, 560);
    this.scrumCooldown = 2;
    this.showMessage("测试：队友前插接应", 1200);
  };

  private triggerQaKeys = () => {
    if (!this.started || !this.ball || this.replayState) return;
    const user = this.players.find((player) => player.id === "you");
    if (!user) return;
    user.sprite.setPosition(500, FIELD.centerY);
    user.sprite.setVelocity(0, 0);
    user.kickCooldown = 0;
    this.ball.setPosition(540, FIELD.centerY);
    this.ball.setVelocity(0, 0);
    for (const player of this.players) {
      if (player.side === "away") {
        player.sprite.setPosition(980, player.sprite.y);
        player.kickCooldown = 3;
      }
    }
    if (this.hud.app instanceof HTMLElement) this.hud.app.dataset.lastAction = "ready";
    this.showMessage("测试：按 Q 传球 / E 射门", 1400);
  };

  private triggerQaPassing = () => {
    if (!this.started || !this.ball || this.replayState) return;
    const wing = this.players.find((player) => player.id === "h-wing");
    const defender = this.players.find((player) => player.id === "h-def");
    const user = this.players.find((player) => player.id === "you");
    if (!wing || !defender || !user) return;
    this.ball.setPosition(wing.sprite.x + 34, wing.sprite.y);
    this.ball.setVelocity(0, 0);
    wing.kickCooldown = 0;
    defender.sprite.setPosition(590, 500);
    user.sprite.setPosition(700, 285);
    for (const player of this.players) {
      if (player.side === "away") {
        player.sprite.setPosition(Math.max(930, player.sprite.x), player.sprite.y);
        player.kickCooldown = 3;
      }
    }
    this.scrumCooldown = 2;
    this.showMessage("测试：队友连续传切", 1200);
  };

  private triggerQaFinish = () => {
    if (!this.started || !this.ball || this.replayState) return;
    const wing = this.players.find((player) => player.id === "h-wing");
    if (!wing) return;
    wing.sprite.setPosition(1038, FIELD.centerY);
    wing.sprite.setVelocity(0, 0);
    wing.kickCooldown = 0;
    this.ball.setPosition(1068, FIELD.centerY);
    this.ball.setVelocity(0, 0);
    for (const player of this.players) {
      if (player.side === "away" && player.role !== "keeper") {
        player.sprite.setPosition(820, player.sprite.y);
        player.kickCooldown = 3;
      }
    }
    this.scrumCooldown = 2;
    this.showMessage("测试：禁区内 AI 射门", 1000);
  };

  private advanceQaReplay = () => {
    const replay = this.replayState;
    if (!replay) return;
    if (replay.phase === "goal") {
      replay.elapsed = 950;
      this.updateReplay(0);
    } else if (replay.phase === "sideline") {
      replay.frameCursor = Math.min(
        replay.frames.length - 1,
        Math.max(replay.frameCursor, Math.ceil(replay.frames.length * 0.56))
      );
      this.updateReplay(0);
    } else {
      replay.frameCursor = replay.frames.length - 1;
      this.updateReplay(0);
    }
    this.updatePresentation(0);
    this.updateHud();
  };

  private toggleMute = () => {
    const muted = this.soundBoard.toggle();
    const button = document.querySelector<HTMLButtonElement>("#muteButton");
    if (button) {
      button.textContent = muted ? "OFF" : "SND";
      button.setAttribute("aria-label", muted ? "开启声音" : "静音");
    }
  };

  private updateUser(dt: number) {
    const user = this.players.find((player) => player.id === "you");
    if (!user || !this.ball) return;

    const move = this.inputController.getMoveVector();
    const wantsDash = this.inputController.isDashDown() && this.stamina > 0;
    const speed = user.speed * (wantsDash ? 1.55 : 1);
    user.sprite.setVelocity(move.x * speed, move.y * speed);

    if (wantsDash && move.lengthSq() > 0) {
      this.stamina = Math.max(0, this.stamina - 42 * dt);
      this.emitTrail(user.sprite.x, user.sprite.y, 0x64e086);
    } else {
      this.stamina = Math.min(100, this.stamina + 24 * dt);
    }

    if (this.inputController.consumeShoot()) {
      this.tryKick(user, "shoot");
    }
    if (this.inputController.consumePass()) {
      this.tryKick(user, "pass");
    }
  }

  private updateAi(dt: number) {
    const ball = this.ball;
    if (!ball) return;
    const homePressure = this.getNearestOutfield("home");
    const awayPressure = this.getNearestOutfield("away");

    for (const agent of this.players) {
      if (agent.id === "you") continue;

      const target = this.getAiTarget(agent, homePressure?.id, awayPressure?.id);
      this.moveToward(agent, target.x, target.y, dt);

      const distance = Phaser.Math.Distance.Between(agent.sprite.x, agent.sprite.y, ball.x, ball.y);
      if (distance < 50 && agent.kickCooldown <= 0 && this.aiActionCooldown <= 0) {
        if (agent.role === "keeper") {
          this.aiClear(agent);
        } else if (agent.side === "home") {
          this.aiHomeKick(agent);
        } else {
          this.aiAwayKick(agent);
        }
      }
    }
  }

  private getAiTarget(agent: PlayerAgent, homePressureId?: string, awayPressureId?: string) {
    const ball = this.ball!;
    if (agent.role === "keeper") {
      const x = agent.side === "home" ? 92 : 1188;
      const y = Phaser.Math.Clamp(ball.y, FIELD.goalTop + 38, FIELD.goalBottom - 38);
      return { x, y };
    }

    if (this.passWindow > 0 && agent.id === this.passReceiverId) {
      const velocity = (ball.body as Phaser.Physics.Arcade.Body).velocity;
      return {
        x: Phaser.Math.Clamp(ball.x + velocity.x * 0.08, FIELD.left + 28, FIELD.right - 28),
        y: Phaser.Math.Clamp(ball.y + velocity.y * 0.08, FIELD.top + 28, FIELD.bottom - 28)
      };
    }

    const isPrimaryPressure =
      (agent.side === "home" && agent.id === homePressureId) ||
      (agent.side === "away" && agent.id === awayPressureId);
    if (isPrimaryPressure) {
      const velocity = (ball.body as Phaser.Physics.Arcade.Body).velocity;
      return {
        x: Phaser.Math.Clamp(ball.x + velocity.x * 0.12, FIELD.left + 28, FIELD.right - 28),
        y: Phaser.Math.Clamp(ball.y + velocity.y * 0.12, FIELD.top + 28, FIELD.bottom - 28)
      };
    }

    if (agent.side === "away") {
      const attacking = ball.x < FIELD.centerX + 70;
      if (agent.role === "striker") {
        return {
          x: Phaser.Math.Clamp(ball.x - (attacking ? 145 : 95), 170, 900),
          y: Phaser.Math.Clamp(ball.y * 0.68 + FIELD.centerY * 0.32, 170, 550)
        };
      }
      if (agent.role === "wing") {
        return {
          x: Phaser.Math.Clamp(ball.x - (attacking ? 80 : 30), 210, 980),
          y: ball.y < FIELD.centerY ? 520 : 200
        };
      }
      return {
        x: Phaser.Math.Clamp(ball.x + (attacking ? 155 : 210), 430, 1060),
        y: Phaser.Math.Clamp(ball.y + (ball.y < FIELD.centerY ? 115 : -115), 190, 530)
      };
    }

    if (agent.role === "wing") {
      return {
        x: Phaser.Math.Clamp(ball.x + 155, 300, 1060),
        y: ball.y < FIELD.centerY ? 505 : 205
      };
    }
    if (agent.role === "defender") {
      return {
        x: Phaser.Math.Clamp(ball.x - (ball.x < FIELD.centerX ? 90 : 185), 170, 720),
        y: Phaser.Math.Clamp(ball.y + (ball.y < FIELD.centerY ? 125 : -125), 190, 530)
      };
    }

    return { x: ball.x, y: ball.y };
  }

  private getNearestOutfield(side: Side) {
    if (!this.ball) return undefined;
    const receiver = this.players.find(
      (player) => player.id === this.passReceiverId && player.side === side
    );
    if (this.passWindow > 0 && receiver) return receiver;
    return this.players
      .filter((player) => player.side === side && player.role !== "keeper" && player.id !== "you")
      .sort(
        (a, b) =>
          Phaser.Math.Distance.Squared(a.sprite.x, a.sprite.y, this.ball!.x, this.ball!.y) -
          Phaser.Math.Distance.Squared(b.sprite.x, b.sprite.y, this.ball!.x, this.ball!.y)
      )[0];
  }

  private moveToward(agent: PlayerAgent, x: number, y: number, dt: number) {
    const vector = new Phaser.Math.Vector2(x - agent.sprite.x, y - agent.sprite.y);
    const distance = vector.length();
    if (distance < 6) {
      agent.sprite.setVelocity(agent.sprite.body!.velocity.x * 0.8, agent.sprite.body!.velocity.y * 0.8);
      return;
    }
    vector.normalize();
    const pressure = this.ball && Phaser.Math.Distance.Between(agent.sprite.x, agent.sprite.y, this.ball.x, this.ball.y) < 160 ? 1.16 : 1;
    agent.sprite.setVelocity(vector.x * agent.speed * pressure, vector.y * agent.speed * pressure);

    if (pressure > 1 && dt > 0) this.emitTrail(agent.sprite.x, agent.sprite.y, agent.side === "home" ? 0x64e086 : 0xffcf5a);
  }

  private tryKick(agent: PlayerAgent, mode: "shoot" | "pass") {
    if (!this.ball || agent.kickCooldown > 0) return;
    const distance = Phaser.Math.Distance.Between(agent.sprite.x, agent.sprite.y, this.ball.x, this.ball.y);
    if (distance > 62) {
      this.showMessage("靠近球再出脚", 900);
      return;
    }

    if (mode === "pass") {
      const mate = this.findBestHomeMate(agent);
      this.kickBallToward(mate.sprite.x, mate.sprite.y, 520, 0x64e086);
      this.spark = Math.min(5, this.spark + 0.25);
      this.showMessage("直塞传球", 850);
    } else {
      const aim = this.inputController.getMoveVector();
      const y = aim.lengthSq() > 0.1 ? this.ball.y + aim.y * 120 : FIELD.centerY;
      const power = 620 + this.spark * 42;
      this.kickBallToward(FIELD.right + 90, Phaser.Math.Clamp(y, FIELD.goalTop + 10, FIELD.goalBottom - 10), power, 0xff6c67);
      this.showMessage(this.spark >= 3 ? "火力射门" : "射门", 850);
    }
    if (this.hud.app instanceof HTMLElement) this.hud.app.dataset.lastAction = mode;
    agent.kickCooldown = 0.22;
  }

  private aiHomeKick(agent: PlayerAgent) {
    if (!this.ball) return;
    if (this.ball.x > 1010 && Math.abs(this.ball.y - FIELD.centerY) < 190) {
      this.aiShoot(agent, "home");
    } else {
      const target = this.findBestPassTarget(agent);
      this.aiPass(agent, target);
    }
  }

  private aiAwayKick(agent: PlayerAgent) {
    if (!this.ball) return;
    if (this.ball.x < 270 && Math.abs(this.ball.y - FIELD.centerY) < 190) {
      this.aiShoot(agent, "away");
    } else {
      const target = this.findBestPassTarget(agent);
      this.aiPass(agent, target);
    }
  }

  private aiPass(agent: PlayerAgent, target: PlayerAgent) {
    const direction = agent.side === "home" ? 1 : -1;
    const targetBody = target.sprite.body as Phaser.Physics.Arcade.Body;
    const leadX = target.sprite.x + targetBody.velocity.x * 0.16 + direction * 28;
    const leadY = target.sprite.y + targetBody.velocity.y * 0.12;
    this.kickBallToward(leadX, leadY, 430, agent.side === "home" ? 0x64e086 : 0xffcf5a);
    this.passReceiverId = target.id;
    this.passWindow = 1.25;
    this.aiActionCooldown = 0.58;
    this.aiPassCount += 1;
    agent.kickCooldown = 0.9;
    target.kickCooldown = Math.max(target.kickCooldown, 0.45);
    if (this.aiPassCount % 3 === 1) {
      this.showMessage(agent.side === "home" ? "队友传切接应" : "对手连续传递", 700);
    }
  }

  private aiShoot(agent: PlayerAgent, side: Side) {
    const goalX = side === "home" ? FIELD.right + 70 : FIELD.left - 70;
    const targetY = Phaser.Math.Between(FIELD.goalTop + 32, FIELD.goalBottom - 32);
    this.kickBallToward(goalX, targetY, 575, side === "home" ? 0x64e086 : 0xffcf5a);
    this.passReceiverId = undefined;
    this.passWindow = 0;
    this.aiActionCooldown = 0.62;
    this.aiShotCount += 1;
    agent.kickCooldown = 0.78;
  }

  private aiClear(agent: PlayerAgent) {
    if (!this.ball) return;
    const direction = agent.side === "home" ? 1 : -1;
    this.kickBallToward(agent.sprite.x + direction * 360, Phaser.Math.Between(190, 530), 610, agent.side === "home" ? 0x64e086 : 0xffcf5a);
    agent.kickCooldown = 0.9;
  }

  private findBestHomeMate(agent: PlayerAgent) {
    const mates = this.players.filter((player) => player.side === "home" && player.id !== agent.id && player.role !== "keeper");
    return mates.sort((a, b) => b.sprite.x - a.sprite.x)[0] ?? agent;
  }

  private findBestPassTarget(agent: PlayerAgent) {
    const direction = agent.side === "home" ? 1 : -1;
    const opponents = this.players.filter((player) => player.side !== agent.side);
    const allCandidates = this.players.filter(
      (player) => player.side === agent.side && player.id !== agent.id && player.role !== "keeper"
    );
    const spacedCandidates = allCandidates.filter(
      (player) =>
        Phaser.Math.Distance.Between(
          agent.sprite.x,
          agent.sprite.y,
          player.sprite.x,
          player.sprite.y
        ) > 125
    );
    const candidates = spacedCandidates.length > 0 ? spacedCandidates : allCandidates;
    if (candidates.length === 0) return agent;

    return candidates
      .map((candidate) => {
        const nearestOpponent = Math.min(
          ...opponents.map((opponent) =>
            Phaser.Math.Distance.Between(
              candidate.sprite.x,
              candidate.sprite.y,
              opponent.sprite.x,
              opponent.sprite.y
            )
          )
        );
        const forwardGain = (candidate.sprite.x - agent.sprite.x) * direction;
        const passDistance = Phaser.Math.Distance.Between(
          agent.sprite.x,
          agent.sprite.y,
          candidate.sprite.x,
          candidate.sprite.y
        );
        const laneChange = Math.abs(candidate.sprite.y - agent.sprite.y);
        const backwardPenalty = forwardGain < -80 ? 120 : 0;
        const score =
          nearestOpponent * 1.25 +
          Phaser.Math.Clamp(forwardGain, -80, 260) * 0.75 +
          Phaser.Math.Clamp(laneChange, 0, 190) * 0.28 -
          Math.abs(passDistance - 250) * 0.22 -
          backwardPenalty;
        return { candidate, score };
      })
      .sort((a, b) => b.score - a.score)[0].candidate;
  }

  private kickBallToward(x: number, y: number, speed: number, color: number) {
    if (!this.ball) return;
    const vector = new Phaser.Math.Vector2(x - this.ball.x, y - this.ball.y).normalize();
    const body = this.ball.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(vector.x * speed, vector.y * speed);
    this.cameras.main.shake(90, 0.0025);
    this.soundBoard.kick(speed / 700);
    this.emitTrail(this.ball.x, this.ball.y, color, 9);
    const impact = this.add.circle(this.ball.x, this.ball.y, 13).setStrokeStyle(4, color, 0.9).setDepth(12);
    this.tweens.add({
      targets: impact,
      scale: 3.2,
      alpha: 0,
      duration: 260,
      ease: "Quad.Out",
      onComplete: () => impact.destroy()
    });
  }

  private slowBall() {
    if (!this.ball) return;
    const body = this.ball.body as Phaser.Physics.Arcade.Body;
    body.velocity.scale(0.992);
    if (body.velocity.lengthSq() < 36) body.setVelocity(0, 0);
  }

  private resolveBallScrum(dt: number) {
    if (!this.ball) return;
    this.scrumCooldown = Math.max(0, this.scrumCooldown - dt);
    if (this.scrumCooldown > 0) return;

    const nearby = this.players.filter(
      (player) =>
        Phaser.Math.Distance.Between(player.sprite.x, player.sprite.y, this.ball!.x, this.ball!.y) <
        72
    );
    const speed = (this.ball.body as Phaser.Physics.Arcade.Body).velocity.length();
    if (nearby.length >= 3 && speed < 140) {
      this.scrumTimer += dt;
    } else {
      this.scrumTimer = Math.max(0, this.scrumTimer - dt * 2.5);
    }

    if (this.scrumTimer < 0.55) return;

    const escape = this.findOpenBallDirection(nearby);
    const releaseX = Phaser.Math.Clamp(this.ball.x + escape.x * 22, FIELD.left + 28, FIELD.right - 28);
    const releaseY = Phaser.Math.Clamp(this.ball.y + escape.y * 22, FIELD.top + 28, FIELD.bottom - 28);
    this.ball.setPosition(releaseX, releaseY);
    this.ball.setVelocity(escape.x * 390, escape.y * 390);

    for (const player of nearby) {
      const separation = new Phaser.Math.Vector2(
        player.sprite.x - this.ball.x,
        player.sprite.y - this.ball.y
      );
      if (separation.lengthSq() < 1) separation.set(-escape.x, -escape.y);
      separation.normalize().scale(115);
      player.sprite.setVelocity(
        player.sprite.body!.velocity.x + separation.x,
        player.sprite.body!.velocity.y + separation.y
      );
      player.kickCooldown = Math.max(player.kickCooldown, 0.35);
    }

    this.scrumTimer = 0;
    this.scrumCooldown = 1.15;
    this.scrumReleaseCount += 1;
    this.emitTrail(this.ball.x, this.ball.y, 0xffffff, 16);
    this.cameras.main.shake(100, 0.003);
    this.showMessage("混战解围！球弹向空当", 950);
  }

  private findOpenBallDirection(nearby: PlayerAgent[]) {
    let best = new Phaser.Math.Vector2(1, 0);
    let bestScore = -Infinity;

    for (let index = 0; index < 12; index += 1) {
      const angle = (Math.PI * 2 * index) / 12;
      const direction = new Phaser.Math.Vector2(Math.cos(angle), Math.sin(angle));
      const sampleX = this.ball!.x + direction.x * 105;
      const sampleY = this.ball!.y + direction.y * 105;
      if (
        sampleX < FIELD.left + 34 ||
        sampleX > FIELD.right - 34 ||
        sampleY < FIELD.top + 34 ||
        sampleY > FIELD.bottom - 34
      ) {
        continue;
      }
      const nearestPlayer = Math.min(
        ...this.players.map((player) =>
          Phaser.Math.Distance.Between(sampleX, sampleY, player.sprite.x, player.sprite.y)
        )
      );
      const crowdAlignment = nearby.reduce((score, player) => {
        const away = new Phaser.Math.Vector2(
          this.ball!.x - player.sprite.x,
          this.ball!.y - player.sprite.y
        ).normalize();
        return score + direction.dot(away);
      }, 0);
      const score = nearestPlayer + crowdAlignment * 24;
      if (score > bestScore) {
        bestScore = score;
        best = direction;
      }
    }
    return best;
  }

  private keepPlayersInField() {
    for (const player of this.players) {
      player.sprite.x = Phaser.Math.Clamp(player.sprite.x, FIELD.left + 12, FIELD.right - 12);
      player.sprite.y = Phaser.Math.Clamp(player.sprite.y, FIELD.top + 12, FIELD.bottom - 12);
    }
  }

  private checkGoals() {
    if (!this.ball) return;
    const inGoalMouth = this.ball.y > FIELD.goalTop && this.ball.y < FIELD.goalBottom;
    const ballBody = this.ball.body as Phaser.Physics.Arcade.Body;
    if (
      inGoalMouth &&
      ballBody.velocity.length() < 110 &&
      (this.ball.x >= FIELD.right - 4 || this.ball.x <= FIELD.left + 4)
    ) {
      const direction = this.ball.x > FIELD.centerX ? -1 : 1;
      this.ball.setPosition(
        this.ball.x > FIELD.centerX ? FIELD.right - 20 : FIELD.left + 20,
        this.ball.y
      );
      this.ball.setVelocity(direction * 190, ballBody.velocity.y * 0.4);
      this.showMessage("门前混战，球被挡出", 700);
      return;
    }
    if (this.ball.x >= FIELD.right - 4 && inGoalMouth) {
      this.homeScore += 1;
      this.spark = Math.min(5, this.spark + 1);
      this.afterGoal("进球！继续压上", "home");
    }
    if (this.ball.x <= FIELD.left + 4 && inGoalMouth) {
      this.awayScore += 1;
      this.spark = Math.max(1, this.spark - 0.5);
      this.afterGoal("被追回一球，稳住节奏", "away");
    }
  }

  private afterGoal(text: string, scoringSide: Side) {
    if (!this.ball) return;
    this.recordReplayFrame(1000, true);
    this.showMessage(text, 1700);
    this.cameras.main.flash(180, 255, 255, 255);
    this.soundBoard.goal();
    this.physics.world.pause();
    this.ball.setVelocity(0, 0);
    for (const player of this.players) player.sprite.setVelocity(0, 0);
    this.replayState = {
      phase: "goal",
      frames: this.replayFrames.slice(-96),
      elapsed: 0,
      frameCursor: 0,
      frameAccumulator: 0,
      scoringSide
    };
    this.hud.app?.classList.add("is-cinematic");
    this.hud.goalOverlay?.classList.remove("is-hidden");
    this.setReplayLabel("GOAL CAM", false);
    this.emitGoalBurst(this.ball.x, this.ball.y, scoringSide);
    const camera = this.cameras.main;
    camera.stopFollow();
    camera.setDeadzone();
    camera.pan(this.ball.x, this.ball.y, 420, Phaser.Math.Easing.Cubic.Out, true);
    camera.zoomTo(1.72, 520, Phaser.Math.Easing.Cubic.Out, true);
    this.updateHud();
  }

  private updateReplay(deltaMs: number) {
    const replay = this.replayState;
    if (!replay || !this.ball) return;
    replay.elapsed += deltaMs;

    if (replay.phase === "goal") {
      if (replay.elapsed >= 950) {
        replay.phase = "sideline";
        replay.elapsed = 0;
        replay.frameCursor = 0;
        replay.frameAccumulator = 0;
        this.hud.goalOverlay?.classList.add("is-hidden");
        this.setReplayLabel("REPLAY · 边线机位", true);
        this.cameras.main.resetFX();
        this.cameras.main.setZoom(1.3);
        this.replayCameraRotation = replay.scoringSide === "home" ? -0.018 : 0.018;
        this.cameras.main.setRotation(this.replayCameraRotation);
      }
      return;
    }

    replay.frameAccumulator += deltaMs * 0.72;
    while (replay.frameAccumulator >= 50 && replay.frameCursor < replay.frames.length - 1) {
      replay.frameAccumulator -= 50;
      replay.frameCursor += 1;
    }

    const frame = replay.frames[replay.frameCursor];
    this.applyReplayFrame(frame);
    const progress = replay.frames.length > 1 ? replay.frameCursor / (replay.frames.length - 1) : 1;
    if (progress >= 0.55 && replay.phase !== "ball") {
      replay.phase = "ball";
      this.setReplayLabel("REPLAY · BALL CAM", true);
      this.cameras.main.zoomTo(2.12, 360, Phaser.Math.Easing.Sine.Out, true);
    }

    if (replay.phase === "sideline") {
      const goalX = replay.scoringSide === "home" ? FIELD.right : FIELD.left;
      this.cameras.main.centerOn(Phaser.Math.Linear(frame.ball.x, goalX, 0.18), frame.ball.y);
    } else {
      const previous = replay.frames[Math.max(0, replay.frameCursor - 1)];
      const angle = Phaser.Math.Angle.Between(
        previous.ball.x,
        previous.ball.y,
        frame.ball.x,
        frame.ball.y
      );
      const facingAngle = Math.abs(angle) > Math.PI / 2 ? angle - Math.sign(angle) * Math.PI : angle;
      const lead = 72;
      this.cameras.main.centerOn(
        frame.ball.x + Math.cos(angle) * lead,
        frame.ball.y + Math.sin(angle) * lead
      );
      this.replayCameraRotation = Phaser.Math.Angle.RotateTo(
        this.replayCameraRotation,
        -facingAngle * 0.34,
        0.035
      );
      this.cameras.main.setRotation(this.replayCameraRotation);
    }

    if (replay.frameCursor >= replay.frames.length - 1) this.endReplay();
  }

  private applyReplayFrame(frame: ReplayFrame) {
    if (!this.ball) return;
    this.ball.setPosition(frame.ball.x, frame.ball.y);
    this.ball.setRotation(frame.ball.rotation);
    for (const state of frame.players) {
      this.players.find((player) => player.id === state.id)?.sprite.setPosition(state.x, state.y);
    }
  }

  private endReplay() {
    this.replayState = undefined;
    this.hud.app?.classList.remove("is-cinematic");
    this.setReplayLabel("LIVE · PLAYER FOCUS", false);
    this.resetPositions();
    this.restoreMatchCamera(true);
    this.physics.world.resume();
    this.showMessage("回到比赛", 900);
  }

  private recordReplayFrame(deltaMs: number, force = false) {
    if (!this.ball || this.replayState) return;
    this.replayRecordAccumulator += deltaMs;
    if (!force && this.replayRecordAccumulator < 50) return;
    this.replayRecordAccumulator = 0;
    this.replayFrames.push({
      ball: { x: this.ball.x, y: this.ball.y, rotation: this.ball.rotation },
      players: this.players.map((player) => ({
        id: player.id,
        x: player.sprite.x,
        y: player.sprite.y
      }))
    });
    if (this.replayFrames.length > 120) this.replayFrames.shift();
  }

  private resetPositions() {
    const positions: Record<string, [number, number]> = {
      you: [360, FIELD.centerY],
      "h-wing": [275, 238],
      "h-def": [238, 482],
      "h-keeper": [92, FIELD.centerY],
      "a-striker": [918, 236],
      "a-wing": [940, 484],
      "a-def": [1056, FIELD.centerY],
      "a-keeper": [1188, FIELD.centerY]
    };
    for (const player of this.players) {
      const [x, y] = positions[player.id];
      player.sprite.setPosition(x, y);
      player.sprite.setVelocity(0, 0);
    }
    this.ball?.setPosition(FIELD.centerX, FIELD.centerY);
    this.ball?.setVelocity(0, 0);
    this.replayFrames = [];
    this.replayRecordAccumulator = 0;
    this.scrumTimer = 0;
    this.scrumCooldown = 0;
    this.passReceiverId = undefined;
    this.passWindow = 0;
    this.aiActionCooldown = 0;
    this.updatePresentation(0);
  }

  private finishMatch() {
    if (this.matchOver) return;
    this.matchOver = true;
    this.started = false;
    this.ball?.setVelocity(0, 0);
    for (const player of this.players) player.sprite.setVelocity(0, 0);
    const result =
      this.homeScore > this.awayScore
        ? "比赛结束：你赢了"
        : this.homeScore < this.awayScore
          ? "比赛结束：对手赢了"
          : "比赛结束：平局";
    this.showMessage(result, 60000);
    const panel = document.querySelector("#startPanel");
    const button = document.querySelector<HTMLButtonElement>("#startButton");
    panel?.classList.remove("is-hidden");
    if (button) button.textContent = "再来一局";
  }

  private emitTrail(x: number, y: number, tint: number, quantity = 1) {
    if (!this.particles) return;
    this.particles.setParticleTint(tint);
    this.particles.explode(quantity, x, y);
  }

  private emitGoalBurst(x: number, y: number, scoringSide: Side) {
    const colors = scoringSide === "home" ? [0x64e086, 0xffffff, 0x3fb2ff] : [0xffcf5a, 0xff6c67, 0xffffff];
    colors.forEach((color, index) => {
      this.time.delayedCall(index * 80, () => this.emitTrail(x, y, color, 34));
    });
    for (let index = 0; index < 4; index += 1) {
      const ring = this.add
        .ellipse(x, y, 36 + index * 12, 36 + index * 12)
        .setStrokeStyle(5, colors[index % colors.length], 0.86)
        .setDepth(15);
      this.tweens.add({
        targets: ring,
        scale: 4.5,
        alpha: 0,
        duration: 620 + index * 90,
        ease: "Cubic.Out",
        onComplete: () => ring.destroy()
      });
    }
  }

  private updatePresentation(_dt: number) {
    if (!this.ball) return;
    this.ballShadow?.setPosition(this.ball.x + 6, this.ball.y + 9);
    const ballSpeed = (this.ball.body as Phaser.Physics.Arcade.Body).velocity.length();
    this.ballGlow
      ?.setPosition(this.ball.x, this.ball.y)
      .setScale(1 + Math.min(ballSpeed / 1100, 0.65))
      .setAlpha(0.06 + Math.min(ballSpeed / 8000, 0.09));
    for (const player of this.players) {
      player.shadow.setPosition(player.sprite.x + 5, player.sprite.y + 10);
    }
    const user = this.players.find((player) => player.id === "you");
    if (user) {
      this.controlledMarker?.setPosition(user.sprite.x, user.sprite.y);
      if (!this.replayState && this.cameraFocus) {
        const ballWeight = Phaser.Math.Clamp(
          Phaser.Math.Distance.Between(user.sprite.x, user.sprite.y, this.ball.x, this.ball.y) / 700,
          0.18,
          0.38
        );
        this.cameraFocus.setPosition(
          Phaser.Math.Linear(user.sprite.x, this.ball.x, ballWeight),
          Phaser.Math.Linear(user.sprite.y, this.ball.y, ballWeight)
        );
      }
    }
  }

  private restoreMatchCamera(snap = false) {
    if (!this.cameraFocus) return;
    const camera = this.cameras.main;
    camera.resetFX();
    this.replayCameraRotation = 0;
    camera.setRotation(0);
    camera.setZoom(1.08);
    camera.setBounds(0, 0, WIDTH, HEIGHT);
    camera.startFollow(this.cameraFocus, false, snap ? 1 : 0.08, snap ? 1 : 0.08);
    camera.setDeadzone(120, 80);
    this.setReplayLabel("LIVE · PLAYER FOCUS", false);
    if (snap) this.time.delayedCall(40, () => camera.setLerp(0.08, 0.08));
  }

  private setReplayLabel(text: string, replayVisible: boolean) {
    if (this.hud.cameraMode) this.hud.cameraMode.textContent = text;
    this.hud.replayBadge?.classList.toggle("is-hidden", !replayVisible);
  }

  private showMessage(text: string, duration: number) {
    if (!this.hud.message) return;
    this.hud.message.textContent = text;
    this.hud.message.classList.remove("is-hidden");
    this.messageUntil = performance.now() + duration;
  }

  private updateHud() {
    if (this.hud.homeScore) this.hud.homeScore.textContent = String(this.homeScore);
    if (this.hud.awayScore) this.hud.awayScore.textContent = String(this.awayScore);
    if (this.hud.clock) {
      const seconds = Math.ceil(this.matchTime);
      this.hud.clock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    }
    if (this.hud.stamina) this.hud.stamina.textContent = `Turbo ${Math.round(this.stamina)}%`;
    if (this.hud.staminaFill) this.hud.staminaFill.style.width = `${this.stamina}%`;
    if (this.hud.spark) this.hud.spark.textContent = `Spark x${this.spark.toFixed(1)}`;
    if (this.hud.app instanceof HTMLElement) {
      this.hud.app.dataset.scrumReleases = String(this.scrumReleaseCount);
      this.hud.app.dataset.ballSpeed = this.ball
        ? Math.round((this.ball.body as Phaser.Physics.Arcade.Body).velocity.length()).toString()
        : "0";
      this.hud.app.dataset.awayMinX = String(
        Math.round(
          Math.min(
            ...this.players
              .filter((player) => player.side === "away")
              .map((player) => player.sprite.x)
          )
        )
      );
      this.hud.app.dataset.homeMaxX = String(
        Math.round(
          Math.max(
            ...this.players
              .filter((player) => player.side === "home")
              .map((player) => player.sprite.x)
          )
        )
      );
      this.hud.app.dataset.aiPasses = String(this.aiPassCount);
      this.hud.app.dataset.aiShots = String(this.aiShotCount);
    }
    if (this.hud.message && performance.now() > this.messageUntil) {
      this.hud.message.classList.add("is-hidden");
    }
  }
}

const startPanel = document.querySelector("#startPanel");
const startButton = document.querySelector<HTMLButtonElement>("#startButton");
const muteButton = document.querySelector<HTMLButtonElement>("#muteButton");

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game-container",
  width: WIDTH,
  height: HEIGHT,
  backgroundColor: "#07170f",
  pixelArt: false,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  physics: {
    default: "arcade",
    arcade: {
      debug: false,
      fps: 60
    }
  },
  scene: StreetStrikerScene
};

const game = new Phaser.Game(config);

startButton?.addEventListener("click", () => {
  startPanel?.classList.add("is-hidden");
  document.dispatchEvent(new Event("street-striker:start"));
});

muteButton?.addEventListener("click", () => {
  document.dispatchEvent(new Event("street-striker:mute"));
});
