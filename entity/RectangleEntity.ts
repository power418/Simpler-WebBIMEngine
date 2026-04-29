import * as THREE from 'three';
import { BaseEntity } from './BaseEntity';
import { createPhongMaterial } from '../utils/materials';

export class RectangleEntity extends BaseEntity {
  width: number;
  length: number;
  height: number;

  constructor(width = 2, length = 1, height = 0) {
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, -length / 2);
    shape.lineTo(width / 2, -length / 2);
    shape.lineTo(width / 2, length / 2);
    shape.lineTo(-width / 2, length / 2);
    shape.lineTo(-width / 2, -length / 2);

    // Flat surface on ground (XZ)
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);

    const material = createPhongMaterial({
      color: 0xcccccc,
      side: THREE.DoubleSide,
      // depthTest: true,
      // depthWrite: false,
      // polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    const mesh = new THREE.Mesh(geometry, material);

    super('rectangle', mesh);

    this.width = width;
    this.length = length;
    this.height = height;

    // Basic metadata for selection and persistence
    mesh.userData = {
      ...mesh.userData,
      label: 'Rectangle Entity',
      type: 'entity',
      entityType: 'rectangle',
      selectable: true,
      locked: false,
      QreaseeCategory: 'Others',
      IFCClass: 'IFCBUILDINGELEMENTPROXY',
      rect: { width, length, height },
    } as any;
  }
}
