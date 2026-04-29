import * as THREE from 'three';
import { BaseEntity } from './BaseEntity';
import { createPhongMaterial } from '../utils/materials';

export class CircleEntity extends BaseEntity {
  radius: number;
  segments: number;
  height: number;

  constructor(radius = 1, segments = 32, height = 0) {
    // Buat shape lingkaran 2D
    const shape = new THREE.Shape();
    shape.absarc(0, 0, radius, 0, Math.PI * 2, false);

    // Bentuk datar di sumbu XZ
    const geometry = new THREE.ShapeGeometry(shape, segments);
    geometry.rotateX(-Math.PI / 2);

    const material = createPhongMaterial({
      color: 0xcccccc,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);

    super('circle', mesh);

    this.radius = radius;
    this.segments = segments;
    this.height = height;

    // Metadata (bisa dipakai buat IFC, selection, dsb)
    mesh.userData = {
      ...mesh.userData,
      label: 'Circle Entity',
      type: 'entity',
      entityType: 'circle',
      selectable: true,
      locked: false,
      QreaseeCategory: 'Others',
      IFCClass: 'IFCBUILDINGELEMENTPROXY',
      circle: { radius, segments, height },
    } as any;
  }
}
