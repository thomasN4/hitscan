import * as THREE from 'three';

// Lighting data, not an sRGB image. Nearest filtering preserves the three
// plateaus; mipmaps would blend them back into smooth shading at a distance.
// All materials share this immutable-after-creation GPU resource.
// Three.js maps normal·light from [-1, 1] to [0, 1]. Extend the darkest
// band across the back-facing half, with transitions at 0 and 0.5 in
// normal·light. Back faces get only ambient fill, not wrapped sunlight
// that would expose their own shadow-map aliasing.
const celGradient = new THREE.DataTexture(
  new Uint8Array([0, 0, 135, 255]), 4, 1, THREE.RedFormat,
);
celGradient.minFilter = THREE.NearestFilter;
celGradient.magFilter = THREE.NearestFilter;
celGradient.generateMipmaps = false;
celGradient.needsUpdate = true;

/** Lit surfaces share one shadow / midtone / highlight ramp. */
export function createCelMaterial(
  parameters: Omit<THREE.MeshToonMaterialParameters, 'gradientMap'>,
): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ ...parameters, gradientMap: celGradient });
}
