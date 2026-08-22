import * as THREE from 'three';

// ---------- Renderer / scene / camera ----------
export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfae8f); // dusty haze
scene.fog = new THREE.Fog(0xbfae8f, 40, 140);

export const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 300);

scene.add(new THREE.HemisphereLight(0xfff3e0, 0x8a7a5c, 0.85));
const sun = new THREE.DirectionalLight(0xffeecc, 1.4);
sun.position.set(40, 60, 25);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
scene.add(sun);

export const clock = new THREE.Clock();

// ---------- Shared collections ----------
export const solids = [];    // meshes that block bullets / sight
export const colliders = []; // AABBs for movement collision
export const bots = [];
export const impacts = [];

// ---------- Shared mutable game state ----------
export const player = {
  pos: new THREE.Vector3(0, 1.7, 48),
  vel: new THREE.Vector3(),
  onGround: true,
  hp: 100,
  alive: true,
  radius: 0.45,
  eyeHeight: 1.7,
};

export const weapon = {
  magSize: 30, mag: 30, reserve: 90,
  fireRate: 0.105, lastShot: 0,
  reloading: false, reloadTime: 2.2, reloadEnd: 0,
  damage: 26, headshotMult: 4,
};

export const game = {
  locked: false,
  started: false,
  shooting: false,
  aiming: false,
  yaw: Math.PI,
  pitch: 0,
  spread: 0.001,
  recoil: 0,
  crouchLerp: 0,
  adsLerp: 0,
  stepTimer: 0.2,
  bobAmt: 0,
  scoreKills: 0,
  scoreDeaths: 0,
  roundTime: 115,
};

export const keys = {};
