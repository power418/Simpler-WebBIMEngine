import * as THREE from "three";

const DEFAULT_SPECULAR = 0x222222;
const DEFAULT_SHININESS = 35;
export const GENERATED_PHONG_MATERIAL_KEY = "__qreaseeGeneratedPhong";

export function createPhongMaterial(
  params: THREE.MeshPhongMaterialParameters = {}
): THREE.MeshPhongMaterial {
  const material = new THREE.MeshPhongMaterial({
    specular: DEFAULT_SPECULAR,
    shininess: DEFAULT_SHININESS,
    ...params,
  });
  material.userData = {
    ...material.userData,
    [GENERATED_PHONG_MATERIAL_KEY]: true,
  };
  return material;
}

export function cloneAsPhongMaterial(
  source: THREE.Material,
  overrides: THREE.MeshPhongMaterialParameters = {}
): THREE.MeshPhongMaterial {
  if (source instanceof THREE.MeshPhongMaterial) {
    const cloned = source.clone();
    cloned.setValues(overrides);
    return cloned;
  }

  const anySource = source as any;
  const material = createPhongMaterial({
    color: anySource.color?.clone?.() ?? 0xffffff,
    specular: anySource.specular?.clone?.() ?? DEFAULT_SPECULAR,
    emissive: anySource.emissive?.clone?.() ?? 0x000000,
    shininess: anySource.shininess ?? DEFAULT_SHININESS,
    map: anySource.map ?? null,
    alphaMap: anySource.alphaMap ?? null,
    aoMap: anySource.aoMap ?? null,
    bumpMap: anySource.bumpMap ?? null,
    displacementMap: anySource.displacementMap ?? null,
    emissiveMap: anySource.emissiveMap ?? null,
    envMap: anySource.envMap ?? null,
    lightMap: anySource.lightMap ?? null,
    normalMap: anySource.normalMap ?? null,
    specularMap: anySource.specularMap ?? null,
    transparent: source.transparent,
    opacity: source.opacity,
    side: source.side,
    alphaTest: source.alphaTest,
    depthTest: source.depthTest,
    depthWrite: source.depthWrite,
    polygonOffset: source.polygonOffset,
    polygonOffsetFactor: source.polygonOffsetFactor,
    polygonOffsetUnits: source.polygonOffsetUnits,
    name: source.name,
    ...overrides,
  });
  material.userData = { ...source.userData };
  return material;
}

export function ensurePhongMaterial(
  material: THREE.Material | THREE.Material[],
  overrides: THREE.MeshPhongMaterialParameters = {}
): THREE.MeshPhongMaterial | THREE.MeshPhongMaterial[] {
  if (Array.isArray(material)) {
    return material.map((mat) => ensureSinglePhongMaterial(mat, overrides));
  }
  return ensureSinglePhongMaterial(material, overrides);
}

export function applyPhongMaterials(root: THREE.Object3D) {
  root.traverse((child: any) => {
    if (!child?.isMesh || !child.material) return;
    if (child.userData?.isHelper) return;
    child.material = ensurePhongMaterial(child.material);
  });
}

function ensureSinglePhongMaterial(
  material: THREE.Material,
  overrides: THREE.MeshPhongMaterialParameters
): THREE.MeshPhongMaterial {
  if (material instanceof THREE.MeshPhongMaterial) {
    material.setValues(overrides);
    material.needsUpdate = true;
    return material;
  }
  return cloneAsPhongMaterial(material, overrides);
}
