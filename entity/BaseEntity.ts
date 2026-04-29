import * as THREE from 'three';

export interface IFCMetadata {
    ifcType?: string;
    ifcId?: number;
    globalId?: string;
    key?: string;
}

export interface EntityTransform {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
}

export class BaseEntity {
    id: string;
    type: string;
    mesh: THREE.Object3D;
    parentId?: string;
    ifc?: IFCMetadata;
    selected: boolean = false;

    constructor(type: string, mesh?: THREE.Object3D) {
        this.id = crypto.randomUUID();
        this.type = type;
        this.mesh = mesh ?? new THREE.Object3D();
        this.mesh.userData.entityId = this.id;
    }

    // 🟢 ===== TRANSFORM METHODS =====

    move(dx: number, dy: number, dz: number) {
        this.mesh.position.add(new THREE.Vector3(dx, dy, dz));
    }

    setPosition(x: number, y: number, z: number) {
        this.mesh.position.set(x, y, z);
    }

    rotate(rx: number, ry: number, rz: number) {
        this.mesh.rotation.x += rx;
        this.mesh.rotation.y += ry;
        this.mesh.rotation.z += rz;
    }

    setRotation(rx: number, ry: number, rz: number) {
        this.mesh.rotation.set(rx, ry, rz);
    }

    scale(sx: number, sy: number, sz: number) {
        this.mesh.scale.multiply(new THREE.Vector3(sx, sy, sz));
    }

    setScale(sx: number, sy: number, sz: number) {
        this.mesh.scale.set(sx, sy, sz);
    }

    getTransform(): EntityTransform {
        return {
            position: this.mesh.position.clone(),
            rotation: this.mesh.rotation.clone(),
            scale: this.mesh.scale.clone(),
        };
    }

    // 🟣 ===== IFC LINKING =====

    attachIFC(metadata: IFCMetadata) {
        this.ifc = { ...metadata };
        this.mesh.userData.ifc = metadata;
    }

    detachIFC() {
        delete this.ifc;
        delete this.mesh.userData.ifc;
    }

    // 🟠 ===== HIERARCHY =====

    addChild(entity: BaseEntity) {
        this.mesh.add(entity.mesh);
        entity.parentId = this.id;
    }

    removeChild(entity: BaseEntity) {
        this.mesh.remove(entity.mesh);
        entity.parentId = undefined;
    }

    // 🔵 ===== SELECTION & CLONING =====

    setSelected(isSelected: boolean) {
        this.selected = isSelected;
        this.mesh.traverse((obj) => {
            if ((obj as THREE.Mesh).material) {
                const mat = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[];
                if (Array.isArray(mat)) {
                    mat.forEach((m) => {
                        if ('emissive' in m) (m as THREE.MeshPhongMaterial).emissive.set(isSelected ? 0x3333ff : 0x000000);
                    });
                } else if ('emissive' in mat) {
                    (mat as THREE.MeshPhongMaterial).emissive.set(isSelected ? 0x3333ff : 0x000000);
                }
            }
        });
    }

    clone(): BaseEntity {
        const clonedMesh = this.mesh.clone(true);
        const clone = new BaseEntity(this.type, clonedMesh);
        if (this.ifc) clone.attachIFC({ ...this.ifc });
        return clone;
    }

    dispose() {
        this.mesh.traverse((obj) => {
            if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
            if ((obj as THREE.Mesh).material) {
                const mat = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[];
                if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
                else mat.dispose();
            }
        });
    }
}
