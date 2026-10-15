import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * Image-based lighting presets, generated in the browser (no downloads).
 * Each is rendered once into a prefiltered environment map.
 */

export const ENVIRONMENTS = {
	studio: 'Studio',
	soft: 'Soft light',
	outdoor: 'Outdoor sky',
};

function gradientDome( top, horizon, bottom, extras = [] ) {

	const scene = new THREE.Scene();
	const geometry = new THREE.SphereGeometry( 50, 64, 32 );
	const colors = [];
	const pos = geometry.attributes.position;
	const c = new THREE.Color();

	for ( let i = 0; i < pos.count; i ++ ) {

		const y = pos.getY( i ) / 50;
		if ( y >= 0 ) c.copy( horizon ).lerp( top, Math.pow( y, 0.6 ) );
		else c.copy( horizon ).lerp( bottom, Math.min( 1, - y * 4 ) );
		colors.push( c.r, c.g, c.b );

	}

	geometry.setAttribute( 'color', new THREE.Float32BufferAttribute( colors, 3 ) );
	scene.add( new THREE.Mesh( geometry, new THREE.MeshBasicMaterial( { vertexColors: true, side: THREE.BackSide } ) ) );
	extras.forEach( ( e ) => scene.add( e ) );
	return scene;

}

function panel( color, intensity, w, h, position, lookAt = new THREE.Vector3() ) {

	const mesh = new THREE.Mesh( new THREE.PlaneGeometry( w, h ), new THREE.MeshBasicMaterial( { color: new THREE.Color( color ).multiplyScalar( intensity ), side: THREE.DoubleSide } ) );
	mesh.position.copy( position );
	mesh.lookAt( lookAt );
	return mesh;

}

const builders = {

	studio: () => new RoomEnvironment(),

	// Even, low-contrast light: good for judging colours and shapes.
	soft: () => gradientDome(
		new THREE.Color( 1.15, 1.15, 1.18 ),
		new THREE.Color( 0.85, 0.85, 0.86 ),
		new THREE.Color( 0.38, 0.37, 0.36 ),
		[ panel( 0xffffff, 2.2, 60, 60, new THREE.Vector3( 0, 45, 0 ) ) ]
	),

	// Blue sky, bright horizon, warm ground and a sun for crisp highlights.
	outdoor: () => {

		const sun = new THREE.Mesh( new THREE.SphereGeometry( 2.2, 16, 8 ), new THREE.MeshBasicMaterial( { color: new THREE.Color( 1, 0.95, 0.85 ).multiplyScalar( 60 ) } ) );
		sun.position.set( 25, 30, 18 );
		return gradientDome(
			new THREE.Color( 0.18, 0.36, 0.85 ).multiplyScalar( 1.6 ),
			new THREE.Color( 1.25, 1.2, 1.1 ),
			new THREE.Color( 0.32, 0.27, 0.2 ),
			[ sun ]
		);

	},

};

export class EnvironmentLibrary {

	constructor( renderer ) {

		this.pmrem = new THREE.PMREMGenerator( renderer );
		this.cache = new Map();

	}

	get( name ) {

		if ( ! builders[ name ] ) name = 'studio';

		if ( ! this.cache.has( name ) ) {

			const scene = builders[ name ]();
			this.cache.set( name, this.pmrem.fromScene( scene, 0.04 ).texture );
			scene.traverse( ( o ) => {

				o.geometry?.dispose();
				o.material?.dispose();

			} );

		}

		return this.cache.get( name );

	}

}
