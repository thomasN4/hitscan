// Arena-only art experiment. All resources are owned by the startup closure;
// nothing reads the DOM or engine at import time. Map changes reload the page.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const INK = '#29383c';
const PAPER = '#eddbb5';
const TEAL = '#608b8b';
const RED = '#b95b45';

// Existing material colours identify the shared world / team / weapon palette.
// This pass changes those materials only in the opt-in arena page.
const COLOURS = new Map<number, number>([
  [0xc9a86c, 0xeddbb5], [0xa8895a, 0xd4ad83], [0x8a6d3f, 0xc39860],
  [0xb59a67, 0xd8c7a0],
  [0x8a6b2e, 0xba6048], [0xd8c39a, 0xe8bb8c], [0x4d4436, 0x596a62],
  [0x4a5a78, 0x537eaa], [0xc9d2df, 0xc5d6df], [0x2f3646, 0x3c546e],
  [0x2b2b2b, 0x697d85], [0x24301f, 0x6a8076], [0x111111, 0x35434b],
  [0x33322f, 0x74818a], [0x26262a, 0x6a7c88], [0x2e2e33, 0x74818a],
  [0x4a331f, 0xae7350], [0x1f1f22, 0x495b65], [0xb9bdc6, 0xd3e0de],
]);

/** Paint surface details rather than introducing apparent walkable geometry. */
function paintedTexture(
  width: number, height: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
  renderer: THREE.WebGLRenderer,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Ligne claire: canvas 2D context unavailable');
  paint(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Mipmaps and anisotropy keep architectural ink from crawling when moving.
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

function facade(renderer: THREE.WebGLRenderer, accent: string): THREE.CanvasTexture {
  return paintedTexture(1024, 512, ctx => {
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, 1024, 512);
    ctx.fillStyle = '#d2b48b';
    ctx.fillRect(0, 454, 1024, 58);
    ctx.fillStyle = accent;
    ctx.fillRect(0, 14, 1024, 24);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const y of [14, 38, 454]) { ctx.moveTo(0, y); ctx.lineTo(1024, y); }
    ctx.stroke();
    // Closed shutters: visibly surface decoration, never an open doorway.
    for (const x of [90, 320, 550, 780]) {
      ctx.fillStyle = '#f7ebcf';
      ctx.fillRect(x - 10, 106, 136, 158);
      ctx.strokeRect(x - 10, 106, 136, 158);
      ctx.fillStyle = accent;
      ctx.fillRect(x, 116, 116, 138);
      ctx.strokeRect(x, 116, 116, 138);
      ctx.beginPath();
      ctx.moveTo(x + 58, 116); ctx.lineTo(x + 58, 254);
      for (const y of [147, 178, 209]) {
        ctx.moveTo(x + 10, y); ctx.lineTo(x + 48, y);
        ctx.moveTo(x + 68, y); ctx.lineTo(x + 106, y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#f7ebcf';
    ctx.fillRect(448, 327, 140, 185);
    ctx.strokeRect(448, 327, 140, 185);
    ctx.fillStyle = accent;
    ctx.fillRect(460, 339, 116, 173);
    ctx.strokeRect(460, 339, 116, 173);
    ctx.strokeRect(473, 352, 90, 71);
    ctx.strokeRect(473, 440, 90, 59);
    ctx.fillStyle = INK;
    ctx.fillRect(553, 424, 5, 13);
    ctx.fillStyle = '#f7ebcf';
    ctx.fillRect(95, 336, 196, 52);
    ctx.strokeRect(95, 336, 196, 52);
    ctx.fillStyle = INK;
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PLACE  04', 193, 371);
  }, renderer);
}

function crateTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  return paintedTexture(512, 512, ctx => {
    ctx.fillStyle = '#cba16a';
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = '#65543e';
    ctx.lineWidth = 3;
    for (const x of [128, 256, 384]) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 512); ctx.stroke();
    }
    ctx.fillStyle = '#e2bd82';
    for (const y of [26, 436]) {
      ctx.fillRect(0, y, 512, 50);
      ctx.strokeRect(0, y, 512, 50);
    }
    ctx.beginPath();
    ctx.moveTo(25, 436); ctx.lineTo(427, 76);
    ctx.lineTo(487, 76); ctx.lineTo(85, 436); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = INK;
    for (const x of [30, 482]) for (const y of [50, 461]) {
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#f4e4c0';
    ctx.fillRect(330, 302, 115, 80);
    ctx.strokeRect(330, 302, 115, 80);
    ctx.fillStyle = INK;
    ctx.font = 'bold 48px sans-serif';
    ctx.fillText('↑↑', 354, 359);
  }, renderer);
}

function uniformTexture(renderer: THREE.WebGLRenderer, colour: string): THREE.CanvasTexture {
  return paintedTexture(256, 256, ctx => {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(128, 20); ctx.lineTo(128, 256);
    ctx.moveTo(85, 0); ctx.lineTo(104, 37); ctx.lineTo(128, 20);
    ctx.lineTo(152, 37); ctx.lineTo(171, 0);
    ctx.stroke();
    for (const x of [36, 160]) {
      ctx.strokeRect(x, 76, 60, 56);
      ctx.beginPath(); ctx.moveTo(x, 89); ctx.lineTo(x + 60, 89); ctx.stroke();
    }
    ctx.fillStyle = '#dbcb9d';
    ctx.fillRect(0, 222, 256, 22);
    ctx.strokeRect(0, 222, 256, 22);
    ctx.fillStyle = INK;
    ctx.fillRect(113, 222, 30, 22);
  }, renderer);
}

function faceTexture(renderer: THREE.WebGLRenderer, helmet: boolean): THREE.CanvasTexture {
  return paintedTexture(256, 256, ctx => {
    ctx.fillStyle = '#e8bb8c';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = helmet ? '#537eaa' : '#665343';
    ctx.fillRect(0, 0, 256, helmet ? 84 : 48);
    ctx.fillStyle = INK;
    for (const x of [77, 174]) {
      ctx.beginPath(); ctx.ellipse(x, 130, 6, 9, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(128, 140); ctx.lineTo(121, 170); ctx.lineTo(137, 170);
    ctx.moveTo(104, 207); ctx.lineTo(149, 207);
    ctx.stroke();
  }, renderer);
}

export interface IllustrationPass {
  resize(): void;
  update(debugView: boolean): void;
}

/** Call once, after the arena, bots and all camera-parented weapons exist. */
export function initLigneClaire(scene: THREE.Scene, renderer: THREE.WebGLRenderer): IllustrationPass {
  scene.background = new THREE.Color(0xb3d5da);
  scene.fog = new THREE.Fog(0xb3d5da, 110, 240);
  scene.traverse(object => {
    if (object instanceof THREE.HemisphereLight) {
      object.color.set(0xffffff);
      object.groundColor.set(0xf3ead7);
      object.intensity = 2.7;
    } else if (object instanceof THREE.DirectionalLight) {
      object.color.set(0xfff5df);
      object.intensity = 0.55;
    }
  });

  const ramp = new THREE.DataTexture(new Uint8Array([0, 0, 205, 255]), 4, 1, THREE.RedFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  const ink = new LineMaterial({
    color: 0x29383c, linewidth: 1.35, worldUnits: false,
    depthTest: true, depthWrite: false, alphaToCoverage: true,
  });
  renderer.getSize(ink.resolution);
  // Weapon props have rounded edges. A back-face hull supplies their moving
  // silhouette; crease ink alone cannot outline a smooth barrel. Smooth ONLY
  // the hull normals, leaving the visible material's surface normals intact.
  const silhouette = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthTest: true, depthWrite: false,
    uniforms: {
      resolution: { value: ink.resolution },
      inkColour: { value: new THREE.Color(0x29383c) },
    },
    vertexShader: `
      uniform vec2 resolution;
      #include <common>
      #include <skinning_pars_vertex>
      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
        vec4 n = projectionMatrix * vec4(normalMatrix * objectNormal, 0.0);
        vec2 direction = (n.xy * clip.w - clip.xy * n.w) * resolution;
        direction /= max(length(direction), 0.00001);
        clip.xy += direction * (2.0 * 1.05 / resolution) * clip.w;
        gl_Position = clip;
      }
    `,
    fragmentShader: `
      uniform vec3 inkColour;
      void main() {
        gl_FragColor = vec4(inkColour, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });

  const surfaces = new Set<THREE.MeshToonMaterial>();
  const meshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>[] = [];
  // Collect first: adding children during traverse would visit our ink meshes.
  scene.traverse(object => {
    if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshToonMaterial) {
      meshes.push(object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>);
      surfaces.add(object.material);
    }
  });
  for (const material of surfaces) {
    const colour = COLOURS.get(material.color.getHex());
    if (colour !== undefined) material.color.setHex(colour);
    material.gradientMap = ramp;
    // Offset fills, not ink: coplanar edges stay legible without seeing
    // through foreground walls. Decals retain their own stronger offset.
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
    material.needsUpdate = true;
  }

  const crates = crateTexture(renderer);
  const facades = [facade(renderer, TEAL), facade(renderer, RED)];
  const botPaint = new Map<THREE.MeshToonMaterial, THREE.MeshToonMaterial>();
  const edges = new Map<THREE.BufferGeometry, LineSegmentsGeometry>();
  const hulls = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  const strokes: THREE.Object3D[] = [];
  let building = 0;
  for (const mesh of meshes) {
    const original = mesh.material;
    if (original.name === 'arena-crate') {
      const painted = original.clone();
      painted.color.set(0xffffff);
      painted.map = crates;
      mesh.material = painted;
    } else if (mesh.name === 'arena-building') {
      const painted = original.clone();
      painted.color.set(0xffffff);
      const texture = facades[building++ % facades.length];
      if (!texture) throw new Error('Ligne claire: missing facade');
      painted.map = texture;
      // BoxGeometry order: right, left, top, bottom, front, back.
      // Roofs stay plain; only vertical surfaces carry the painted facade.
      (mesh as THREE.Mesh).material = [painted, painted, original, original, painted, painted];
    } else if (mesh.name === 'bot-head' || mesh.name === 'bot-torso') {
      let painted = botPaint.get(original);
      if (!painted) {
        painted = original.clone();
        painted.map = mesh.name === 'bot-head'
          ? faceTexture(renderer, original.color.getHex() === 0xc5d6df)
          : uniformTexture(renderer, '#' + original.color.getHexString());
        painted.color.set(0xffffff);
        botPaint.set(original, painted);
      }
      // Bots face local +z. Faces and pockets belong on the front only.
      (mesh as THREE.Mesh).material = [original, original, original, original, painted, original];
    }
    if (mesh.geometry instanceof THREE.PlaneGeometry) continue;
    const weaponPart = mesh.name.startsWith('weapon-');
    let geometry = edges.get(mesh.geometry);
    if (!geometry) {
      const creases = new THREE.EdgesGeometry(mesh.geometry, weaponPart ? 65 : 25);
      geometry = new LineSegmentsGeometry().fromEdgesGeometry(creases);
      creases.dispose();
      edges.set(mesh.geometry, geometry);
    }
    const stroke = new LineSegments2(geometry, ink);
    stroke.name = 'ligne-claire-ink';
    // Visual children must never acquire hits if a caller uses recursive rays.
    stroke.raycast = () => {};
    stroke.renderOrder = 1;
    mesh.add(stroke);
    strokes.push(stroke);
    if (weaponPart) {
      let hullGeometry = hulls.get(mesh.geometry);
      if (!hullGeometry) {
        const positions = mesh.geometry.clone();
        positions.deleteAttribute('normal');
        positions.deleteAttribute('uv');
        hullGeometry = mergeVertices(positions, 0.00001);
        positions.dispose();
        hullGeometry.computeVertexNormals();
        hulls.set(mesh.geometry, hullGeometry);
      }
      const hull = new THREE.Mesh(hullGeometry, silhouette);
      hull.name = 'weapon-ink-silhouette';
      hull.raycast = () => {};
      hull.renderOrder = 1;
      mesh.add(hull);
      strokes.push(hull);
    }
  }
  return {
    resize: () => { renderer.getSize(ink.resolution); },
    update: debugView => {
      // Leave the existing diagnostic wireframe unobscured. Parent visibility
      // handles weapon switches, reloads, bot death and respawn automatically.
      for (const stroke of strokes) stroke.visible = !debugView;
    },
  };
}
