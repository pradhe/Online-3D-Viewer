import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export const VIEWS = {
	front: [ 0, 0, 1 ],
	back: [ 0, 0, - 1 ],
	left: [ - 1, 0, 0 ],
	right: [ 1, 0, 0 ],
	top: [ 0, 1, 0.0001 ],
	bottom: [ 0, - 1, 0.0001 ],
	iso: [ 1, 0.8, 1 ],
};

export const RENDER_MODES = {
	shaded: 'Shaded',
	clay: 'Clay',
	wireframe: 'Wireframe',
	xray: 'X-ray',
	normals: 'Normals',
};

const TEXTURE_KEYS = [ 'map', 'normalMap', 'bumpMap', 'specularMap', 'emissiveMap', 'alphaMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'displacementMap', 'lightMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'transmissionMap' ];

function isVisibleInScene( object ) {

	for ( let o = object; o; o = o.parent ) if ( ! o.visible ) return false;
	return true;

}

function disposeObject( root ) {

	root.traverse( ( child ) => {

		if ( child.geometry ) child.geometry.dispose();
		const materials = child.material ? ( Array.isArray( child.material ) ? child.material : [ child.material ] ) : [];

		for ( const m of materials ) {

			for ( const key of TEXTURE_KEYS ) if ( m[ key ] && m[ key ].isTexture ) m[ key ].dispose();
			m.dispose();

		}

	} );

}

function easeInOut( t ) {

	return t < 0.5 ? 2 * t * t : 1 - Math.pow( - 2 * t + 2, 2 ) / 2;

}

export class Viewer extends EventTarget {

	constructor( container ) {

		super();

		this.container = container;
		this.model = null;
		this.meshes = [];
		this.originalMaterials = new Map();
		this.originalSides = new WeakMap();
		this.originalMatrices = new WeakMap();
		this.selection = new Set();
		this.renderMode = 'shaded';
		this.upAxis = 'y';
		this.doubleSided = false;
		this.shadows = false;
		this.lightIntensity = 1;
		this.gizmoMode = null;
		this.measuring = false;
		this.measurements = [];
		this.pendingMeasurePoint = null;
		this.sceneRadius = 5;
		this.cameraAnimation = null;
		this.mixer = null;
		this.animationPlaying = false;
		this.timer = new THREE.Timer();

		this._initRenderer();
		this._initScene();
		this._initControls();
		this._initPostprocessing();
		this._initPointer();

		this._resizeObserver = new ResizeObserver( () => this.resize() );
		this._resizeObserver.observe( container );
		this.resize();

		this.renderer.setAnimationLoop( () => this._tick() );

	}

	// ------------------------------------------------------------------ setup

	_initRenderer() {

		const renderer = new THREE.WebGLRenderer( { antialias: false, powerPreference: 'high-performance' } );
		renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
		renderer.toneMapping = THREE.NeutralToneMapping;
		renderer.toneMappingExposure = 1;
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFShadowMap;
		renderer.domElement.classList.add( 'viewport-canvas' );
		this.container.appendChild( renderer.domElement );
		this.renderer = renderer;

		const labels = new CSS2DRenderer();
		labels.domElement.classList.add( 'viewport-labels' );
		this.container.appendChild( labels.domElement );
		this.labelRenderer = labels;

	}

	_initScene() {

		const scene = new THREE.Scene();
		scene.background = new THREE.Color( '#1d2127' );
		this.scene = scene;

		const pmrem = new THREE.PMREMGenerator( this.renderer );
		scene.environment = pmrem.fromScene( new RoomEnvironment(), 0.04 ).texture;
		scene.environmentIntensity = 1;
		pmrem.dispose();

		this.perspectiveCamera = new THREE.PerspectiveCamera( 45, 1, 0.01, 1000 );
		this.perspectiveCamera.position.set( 6, 4, 8 );
		this.orthographicCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, - 100, 100 );
		this.orthoHeight = 10;
		this.camera = this.perspectiveCamera;

		// Lights. Phong materials (OBJ/MTL) ignore the environment map, so real lights are needed too.
		this.ambient = new THREE.AmbientLight( 0xffffff, 0.25 );
		this.hemi = new THREE.HemisphereLight( 0xdfe8ff, 0x3a3530, 0.9 );
		this.keyLight = new THREE.DirectionalLight( 0xffffff, 1.6 );
		this.keyLight.shadow.mapSize.set( 2048, 2048 );
		this.keyLight.shadow.bias = - 0.0005;
		this.fillLight = new THREE.DirectionalLight( 0xcfdcff, 0.45 );
		this.lights = [ this.ambient, this.hemi, this.keyLight, this.fillLight ];
		this.lights.forEach( ( l ) => {

			l.userData.baseIntensity = l.intensity;
			scene.add( l );

		} );
		scene.add( this.keyLight.target, this.fillLight.target );

		this.pivot = new THREE.Group();
		this.pivot.name = '__pivot';
		scene.add( this.pivot );

		this.helpers = new THREE.Group();
		scene.add( this.helpers );

		this.grid = null;
		this.axes = new THREE.AxesHelper( 1 );
		this.axes.visible = false;
		this.helpers.add( this.axes );

		this.boxHelper = new THREE.Box3Helper( new THREE.Box3(), 0xffc94d );
		this.boxHelper.visible = false;
		this.helpers.add( this.boxHelper );

		this.shadowGround = new THREE.Mesh(
			new THREE.PlaneGeometry( 1, 1 ).rotateX( - Math.PI / 2 ),
			new THREE.ShadowMaterial( { opacity: 0.3 } )
		);
		this.shadowGround.receiveShadow = true;
		this.shadowGround.visible = false;
		this.helpers.add( this.shadowGround );

		this.measureGroup = new THREE.Group();
		scene.add( this.measureGroup );

		this.modeMaterials = {
			clay: new THREE.MeshStandardMaterial( { color: 0xd9d4cb, roughness: 0.85, metalness: 0, side: THREE.DoubleSide } ),
			wireframe: new THREE.MeshBasicMaterial( { color: 0x8fc8ff, wireframe: true } ),
			xray: new THREE.MeshStandardMaterial( { color: 0x8fb8ff, roughness: 0.4, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide } ),
			normals: new THREE.MeshNormalMaterial( { side: THREE.DoubleSide } ),
		};

		this._buildGrid( 10 );

	}

	_initControls() {

		const controls = new OrbitControls( this.camera, this.renderer.domElement );
		controls.enableDamping = true;
		controls.dampingFactor = 0.12;
		controls.screenSpacePanning = true;
		controls.zoomToCursor = true;
		controls.addEventListener( 'start', () => {

			this.cameraAnimation = null;

		} );
		this.controls = controls;

		const transform = new TransformControls( this.camera, this.renderer.domElement );
		transform.addEventListener( 'dragging-changed', ( e ) => {

			controls.enabled = ! e.value;

		} );
		transform.addEventListener( 'objectChange', () => this._emit( 'transformchange' ) );
		this.scene.add( transform.getHelper() );
		this.transform = transform;

	}

	_initPostprocessing() {

		const target = new THREE.WebGLRenderTarget( 1, 1, { type: THREE.HalfFloatType, samples: 4 } );
		const composer = new EffectComposer( this.renderer, target );
		this.renderPass = new RenderPass( this.scene, this.camera );
		this.outlinePass = new OutlinePass( new THREE.Vector2( 1, 1 ), this.scene, this.camera );
		this.outlinePass.visibleEdgeColor.set( '#ffb238' );
		this.outlinePass.hiddenEdgeColor.set( '#8a5a10' );
		this.outlinePass.edgeStrength = 4;
		this.outlinePass.edgeThickness = 1;
		composer.addPass( this.renderPass );
		composer.addPass( this.outlinePass );
		composer.addPass( new OutputPass() );
		this.composer = composer;

	}

	_initPointer() {

		const canvas = this.renderer.domElement;
		this.raycaster = new THREE.Raycaster();
		let down = null;

		canvas.addEventListener( 'pointerdown', ( e ) => {

			// Ignore clicks that grab the transform gizmo.
			down = ( e.button === 0 && this.transform.axis === null ) ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;

		} );

		canvas.addEventListener( 'pointerup', ( e ) => {

			if ( ! down || e.button !== 0 ) return;
			const moved = Math.hypot( e.clientX - down.x, e.clientY - down.y );
			down = null;
			if ( moved > 5 ) return;
			this._handleClick( e );

		} );

		canvas.addEventListener( 'dblclick', ( e ) => {

			if ( this.measuring ) return;
			const hit = this.pick( e );
			if ( hit ) this.focus( [ hit.object ] );
			else this.fit();

		} );

		canvas.addEventListener( 'pointermove', ( e ) => {

			if ( e.buttons !== 0 ) return;
			canvas.style.cursor = this.measuring ? 'crosshair' : '';

		} );

	}

	_handleClick( e ) {

		const hit = this.pick( e );

		if ( this.measuring ) {

			if ( hit ) this._addMeasurePoint( hit.point );
			return;

		}

		if ( ! hit ) {

			if ( ! e.shiftKey ) this.clearSelection();
			return;

		}

		const additive = e.shiftKey || e.ctrlKey || e.metaKey;
		this.select( [ hit.object ], { toggle: additive } );

	}

	// ------------------------------------------------------------------ helpers

	_emit( type, detail = {} ) {

		this.dispatchEvent( new CustomEvent( type, { detail } ) );

	}

	pick( event ) {

		if ( ! this.model ) return null;
		const rect = this.renderer.domElement.getBoundingClientRect();
		const ndc = new THREE.Vector2(
			( ( event.clientX - rect.left ) / rect.width ) * 2 - 1,
			- ( ( event.clientY - rect.top ) / rect.height ) * 2 + 1
		);
		this.raycaster.setFromCamera( ndc, this.camera );
		const hits = this.raycaster.intersectObject( this.model, true );
		return hits.find( ( h ) => h.object.isMesh && isVisibleInScene( h.object ) ) || null;

	}

	resize() {

		const w = Math.max( 1, this.container.clientWidth );
		const h = Math.max( 1, this.container.clientHeight );
		this.renderer.setSize( w, h, false );
		this.labelRenderer.setSize( w, h );
		this.composer.setPixelRatio( this.renderer.getPixelRatio() );
		this.composer.setSize( w, h );
		this.outlinePass.setSize( w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio() );
		this._updateProjection();

	}

	_updateProjection() {

		const w = Math.max( 1, this.container.clientWidth );
		const h = Math.max( 1, this.container.clientHeight );
		const aspect = w / h;
		this.perspectiveCamera.aspect = aspect;
		this.perspectiveCamera.updateProjectionMatrix();
		const o = this.orthographicCamera;
		o.top = this.orthoHeight / 2;
		o.bottom = - this.orthoHeight / 2;
		o.left = - this.orthoHeight / 2 * aspect;
		o.right = this.orthoHeight / 2 * aspect;
		o.updateProjectionMatrix();

	}

	_updateClipPlanes() {

		const R = this.sceneRadius;
		const d = this.camera.position.distanceTo( this.controls.target );

		if ( this.camera.isPerspectiveCamera ) {

			this.camera.near = Math.max( d * 0.005, R * 1e-5 );
			this.camera.far = d + R * 8;

		} else {

			this.camera.near = - ( d + R * 8 );
			this.camera.far = d + R * 8;

		}

		this.camera.updateProjectionMatrix();

	}

	_buildGrid( extent ) {

		if ( this.grid ) {

			this.helpers.remove( this.grid );
			this.grid.geometry.dispose();
			this.grid.material.dispose();

		}

		const cell = Math.pow( 10, Math.floor( Math.log10( Math.max( extent, 1e-6 ) / 10 ) ) );
		let divisions = Math.ceil( extent / cell );
		if ( divisions % 2 ) divisions ++;
		divisions = Math.min( Math.max( divisions, 2 ), 200 );

		const visible = this.grid ? this.grid.visible : true;
		this.grid = new THREE.GridHelper( cell * divisions, divisions, 0x7a8494, 0x4a515c );
		this.grid.material.transparent = true;
		this.grid.material.opacity = 0.55;
		this.grid.material.depthWrite = false;
		this.grid.visible = visible;
		this.gridCellSize = cell;
		this.helpers.add( this.grid );

	}

	// ------------------------------------------------------------------ model

	setModel( object ) {

		this.clearModel();

		this.model = object;
		this.pivot.add( object );

		object.traverse( ( child ) => {

			if ( child.isMesh ) {

				this.meshes.push( child );
				this.originalMaterials.set( child, child.material );
				const mats = Array.isArray( child.material ) ? child.material : [ child.material ];
				mats.forEach( ( m ) => {

					if ( ! this.originalSides.has( m ) ) this.originalSides.set( m, m.side );

				} );

			}

			this.originalMatrices.set( child, child.matrix.clone() );

		} );

		if ( object.animations && object.animations.length ) {

			this.mixer = new THREE.AnimationMixer( object );
			this.playAnimation( 0 );

		}

		this.setRenderMode( this.renderMode );
		this.setDoubleSided( this.doubleSided );
		this.setShadows( this.shadows );
		this._placeModel();
		this.fit( { direction: VIEWS.iso, animate: false } );
		this._emit( 'modelchange' );

	}

	clearModel() {

		this.clearSelection();
		this.clearMeasurements();
		this.setGizmoMode( null );

		if ( this.mixer ) {

			this.mixer.stopAllAction();
			this.mixer = null;
			this.animationPlaying = false;

		}

		if ( this.model ) {

			// Restore originals so they get disposed (mode materials are shared and kept).
			this.meshes.forEach( ( m ) => {

				m.material = this.originalMaterials.get( m );

			} );
			this.pivot.remove( this.model );
			disposeObject( this.model );

		}

		this.model = null;
		this.meshes = [];
		this.originalMaterials.clear();

	}

	/** Centers the model on the grid with its base on the ground. */
	_placeModel() {

		if ( ! this.model ) return;

		this.pivot.position.set( 0, 0, 0 );
		this.pivot.rotation.set( this.upAxis === 'z' ? - Math.PI / 2 : 0, 0, 0 );
		this.pivot.updateMatrixWorld( true );

		const box = new THREE.Box3().setFromObject( this.model );
		if ( box.isEmpty() ) box.set( new THREE.Vector3( - 1, 0, - 1 ), new THREE.Vector3( 1, 1, 1 ) );

		const center = box.getCenter( new THREE.Vector3() );
		this.pivot.position.set( - center.x, - box.min.y, - center.z );
		this.pivot.updateMatrixWorld( true );

		box.translate( this.pivot.position );
		this.modelBox = box;

		const size = box.getSize( new THREE.Vector3() );
		const sphere = box.getBoundingSphere( new THREE.Sphere() );
		this.sceneRadius = Math.max( sphere.radius, 1e-3 );
		const R = this.sceneRadius;

		this._buildGrid( Math.max( size.x, size.z ) * 1.6 );
		// Sit just below the model's base so a flat floor does not flicker with the grid.
		this.grid.position.y = - R * 1e-3;
		this.axes.scale.setScalar( Math.max( size.x, size.y, size.z ) * 0.6 );
		this.boxHelper.box.copy( box );

		this.shadowGround.scale.set( R * 6, 1, R * 6 );
		this.shadowGround.position.set( 0, box.min.y - R * 1e-4, 0 );

		const c = sphere.center;
		this.keyLight.position.set( c.x + R * 1.6, c.y + R * 2.2, c.z - R * 0.4 );
		this.keyLight.target.position.copy( c );
		this.fillLight.position.set( c.x - R * 1.5, c.y + R * 0.6, c.z + R * 1.2 );
		this.fillLight.target.position.copy( c );

		const sc = this.keyLight.shadow.camera;
		sc.left = sc.bottom = - R * 1.2;
		sc.right = sc.top = R * 1.2;
		sc.near = R * 0.1;
		sc.far = R * 6;
		sc.updateProjectionMatrix();
		this.keyLight.shadow.normalBias = R * 0.002;

		this.controls.maxDistance = R * 40;
		this.clearMeasurements();

	}

	setUpAxis( axis ) {

		this.upAxis = axis;
		if ( ! this.model ) return;
		this._placeModel();
		this.fit( { animate: false } );
		this._emit( 'modelchange' );

	}

	// ------------------------------------------------------------------ camera

	_boxOf( objects ) {

		const box = new THREE.Box3();
		for ( const o of objects ) box.expandByObject( o );
		return box;

	}

	fit( { direction, animate = true } = {} ) {

		if ( ! this.model ) return;
		this._frameBox( this.modelBox, direction, animate );

	}

	focus( objects = [ ...this.selection ], animate = true ) {

		if ( ! objects.length ) return this.fit( { animate } );
		const box = this._boxOf( objects );
		if ( box.isEmpty() ) return;
		this._frameBox( box, null, animate );

	}

	setView( name ) {

		if ( ! VIEWS[ name ] ) return;
		if ( this.selection.size ) this._frameBox( this._boxOf( [ ...this.selection ] ), VIEWS[ name ], true );
		else this.fit( { direction: VIEWS[ name ] } );

	}

	_frameBox( box, direction, animate ) {

		const sphere = box.getBoundingSphere( new THREE.Sphere() );
		const r = Math.max( sphere.radius, 1e-3 );
		const target = sphere.center.clone();

		const dir = direction
			? new THREE.Vector3( ...direction ).normalize()
			: this.camera.position.clone().sub( this.controls.target ).normalize();
		if ( ! isFinite( dir.x ) || dir.lengthSq() === 0 ) dir.set( ...VIEWS.iso ).normalize();

		const cam = this.perspectiveCamera;
		const vFov = THREE.MathUtils.degToRad( cam.fov );
		const hFov = 2 * Math.atan( Math.tan( vFov / 2 ) * cam.aspect );
		const fov = Math.min( vFov, hFov );
		let distance = ( r / Math.sin( fov / 2 ) ) * 1.05;
		let zoom = 1;

		if ( this.camera.isOrthographicCamera ) {

			const aspect = cam.aspect;
			zoom = ( this.orthoHeight * Math.min( 1, aspect ) ) / ( 2 * r * 1.1 );
			distance = Math.max( distance, r * 4 );

		}

		const position = target.clone().addScaledVector( dir, distance );

		if ( ! animate ) {

			this.camera.position.copy( position );
			this.controls.target.copy( target );
			if ( this.camera.isOrthographicCamera ) this.camera.zoom = zoom;
			this.camera.updateProjectionMatrix();
			this.controls.update();
			return;

		}

		this.cameraAnimation = {
			start: performance.now(),
			duration: 450,
			fromPos: this.camera.position.clone(),
			toPos: position,
			fromTarget: this.controls.target.clone(),
			toTarget: target,
			fromZoom: this.camera.zoom,
			toZoom: this.camera.isOrthographicCamera ? zoom : this.camera.zoom,
		};

	}

	setProjection( type ) {

		const toOrtho = type === 'orthographic';
		if ( toOrtho === this.camera.isOrthographicCamera ) return;
		this.cameraAnimation = null;

		const target = this.controls.target;
		const persp = this.perspectiveCamera;
		const ortho = this.orthographicCamera;
		const halfFov = THREE.MathUtils.degToRad( persp.fov ) / 2;

		if ( toOrtho ) {

			const d = persp.position.distanceTo( target );
			this.orthoHeight = 2 * d * Math.tan( halfFov );
			ortho.position.copy( persp.position );
			ortho.quaternion.copy( persp.quaternion );
			ortho.zoom = 1;
			this.camera = ortho;

		} else {

			const visibleHeight = this.orthoHeight / ortho.zoom;
			const d = visibleHeight / ( 2 * Math.tan( halfFov ) );
			const dir = ortho.position.clone().sub( target ).normalize();
			persp.position.copy( target ).addScaledVector( dir, d );
			persp.quaternion.copy( ortho.quaternion );
			this.camera = persp;

		}

		this.controls.object = this.camera;
		this.transform.camera = this.camera;
		this.renderPass.camera = this.camera;
		this.outlinePass.renderCamera = this.camera;
		this._updateProjection();
		this.controls.update();
		this._emit( 'projectionchange', { type } );

	}

	setFov( fov ) {

		this.perspectiveCamera.fov = fov;
		this.perspectiveCamera.updateProjectionMatrix();

	}

	setAutoRotate( on ) {

		this.controls.autoRotate = on;
		this.controls.autoRotateSpeed = 1.5;

	}

	// ------------------------------------------------------------------ display

	setRenderMode( mode ) {

		this.renderMode = mode;

		for ( const mesh of this.meshes ) {

			mesh.material = mode === 'shaded' ? this.originalMaterials.get( mesh ) : this.modeMaterials[ mode ];

		}

	}

	setDoubleSided( on ) {

		this.doubleSided = on;

		for ( const mats of this.originalMaterials.values() ) {

			for ( const m of Array.isArray( mats ) ? mats : [ mats ] ) {

				m.side = on ? THREE.DoubleSide : this.originalSides.get( m );
				m.needsUpdate = true;

			}

		}

	}

	setShadows( on ) {

		this.shadows = on;
		this.keyLight.castShadow = on;
		this.shadowGround.visible = on;
		this.meshes.forEach( ( m ) => {

			m.castShadow = on;
			m.receiveShadow = on;

		} );

	}

	setGridVisible( on ) {

		this.grid.visible = on;

	}

	setAxesVisible( on ) {

		this.axes.visible = on;

	}

	setBoundsVisible( on ) {

		this.boxHelper.visible = on;

	}

	setBackground( color ) {

		this.backgroundColor = color;
		this.scene.background = this._untonemapped( new THREE.Color( color ) );

	}

	/**
	 * The background is tone mapped together with the model, which would make the
	 * chosen color look darker. Solve for the input that maps back to the chosen color.
	 */
	_untonemapped( target ) {

		const exposure = this.renderer.toneMappingExposure;
		const t = [ target.r, target.g, target.b ];
		const c = [ ...t ].map( ( v ) => v / exposure );

		for ( let i = 0; i < 200; i ++ ) {

			const out = neutralToneMap( c, exposure );
			for ( let k = 0; k < 3; k ++ ) c[ k ] = THREE.MathUtils.clamp( c[ k ] + ( t[ k ] - out[ k ] ) / exposure, 0, 64 );

		}

		return new THREE.Color().setRGB( c[ 0 ], c[ 1 ], c[ 2 ], THREE.LinearSRGBColorSpace );

	}

	setLightIntensity( value ) {

		this.lightIntensity = value;
		this.lights.forEach( ( l ) => {

			l.intensity = l.userData.baseIntensity * value;

		} );

	}

	setEnvironmentIntensity( value ) {

		this.scene.environmentIntensity = value;

	}

	setExposure( value ) {

		this.renderer.toneMappingExposure = value;
		if ( this.backgroundColor ) this.setBackground( this.backgroundColor );

	}

	// ------------------------------------------------------------------ selection

	select( objects, { toggle = false } = {} ) {

		if ( ! toggle ) this.selection.clear();

		for ( const o of objects ) {

			if ( toggle && this.selection.has( o ) ) this.selection.delete( o );
			else this.selection.add( o );

		}

		this._selectionChanged();

	}

	clearSelection() {

		if ( ! this.selection.size ) return;
		this.selection.clear();
		this._selectionChanged();

	}

	_selectionChanged() {

		this.outlinePass.selectedObjects = [ ...this.selection ];
		this._syncGizmo();
		this._emit( 'selectionchange', { selection: [ ...this.selection ] } );

	}

	setGizmoMode( mode ) {

		this.gizmoMode = mode;
		this._syncGizmo();
		this._emit( 'gizmochange', { mode } );

	}

	_syncGizmo() {

		const [ first ] = this.selection;

		if ( this.gizmoMode && this.selection.size === 1 ) {

			this.transform.setMode( this.gizmoMode );
			this.transform.attach( first );

		} else {

			this.transform.detach();

		}

	}

	resetTransform( objects = [ ...this.selection ] ) {

		for ( const o of objects ) {

			const m = this.originalMatrices.get( o );
			if ( ! m ) continue;
			m.decompose( o.position, o.quaternion, o.scale );

		}

		this._emit( 'transformchange' );

	}

	setVisible( objects, visible ) {

		objects.forEach( ( o ) => {

			o.visible = visible;

		} );
		this._emit( 'visibilitychange' );

	}

	isolate( objects = [ ...this.selection ] ) {

		if ( ! this.model || ! objects.length ) return;
		const keep = new Set();

		for ( const o of objects ) {

			o.traverse( ( c ) => keep.add( c ) );
			for ( let p = o.parent; p; p = p.parent ) keep.add( p );

		}

		this.model.traverse( ( c ) => {

			c.visible = keep.has( c );

		} );
		this._emit( 'visibilitychange' );

	}

	showAll() {

		if ( ! this.model ) return;
		this.model.traverse( ( c ) => {

			c.visible = true;

		} );
		this._emit( 'visibilitychange' );

	}

	// ------------------------------------------------------------------ measure

	setMeasuring( on ) {

		this.measuring = on;
		if ( ! on ) this._dropPendingPoint();
		if ( on ) this.setGizmoMode( null );
		this.renderer.domElement.style.cursor = on ? 'crosshair' : '';
		this._emit( 'measurechange' );

	}

	_marker( point ) {

		const geometry = new THREE.BufferGeometry().setFromPoints( [ point ] );
		const material = new THREE.PointsMaterial( { color: 0xffd34d, size: 9, sizeAttenuation: false, depthTest: false } );
		const marker = new THREE.Points( geometry, material );
		marker.renderOrder = 999;
		return marker;

	}

	_dropPendingPoint() {

		if ( ! this.pendingMeasurePoint ) return;
		const { marker } = this.pendingMeasurePoint;
		this.measureGroup.remove( marker );
		marker.geometry.dispose();
		marker.material.dispose();
		this.pendingMeasurePoint = null;

	}

	_addMeasurePoint( point ) {

		if ( ! this.pendingMeasurePoint ) {

			const marker = this._marker( point );
			this.measureGroup.add( marker );
			this.pendingMeasurePoint = { point: point.clone(), marker };
			return;

		}

		const a = this.pendingMeasurePoint.point;
		const b = point.clone();
		const group = new THREE.Group();
		group.add( this.pendingMeasurePoint.marker );
		this.measureGroup.remove( this.pendingMeasurePoint.marker );
		this.pendingMeasurePoint = null;
		group.add( this._marker( b ) );

		const line = new THREE.Line(
			new THREE.BufferGeometry().setFromPoints( [ a, b ] ),
			new THREE.LineBasicMaterial( { color: 0xffd34d, depthTest: false } )
		);
		line.renderOrder = 998;
		group.add( line );

		const distance = a.distanceTo( b );
		const el = document.createElement( 'div' );
		el.className = 'measure-label';
		el.textContent = formatLength( distance );
		const label = new CSS2DObject( el );
		label.position.copy( a ).lerp( b, 0.5 );
		group.add( label );

		this.measureGroup.add( group );
		this.measurements.push( { a, b, distance, group } );
		this._emit( 'measurechange' );

	}

	clearMeasurements() {

		this._dropPendingPoint();

		for ( const m of this.measurements ) {

			m.group.traverse( ( c ) => {

				if ( c.geometry ) c.geometry.dispose();
				if ( c.material ) c.material.dispose();
				if ( c.isCSS2DObject ) c.element.remove();

			} );
			this.measureGroup.remove( m.group );

		}

		this.measurements = [];
		this._emit( 'measurechange' );

	}

	// ------------------------------------------------------------------ animation

	playAnimation( index ) {

		if ( ! this.mixer ) return;
		this.mixer.stopAllAction();
		const clip = this.model.animations[ index ];
		if ( ! clip ) return;
		this.mixer.clipAction( clip ).play();
		this.animationPlaying = true;
		this._emit( 'animationchange' );

	}

	setAnimationPlaying( on ) {

		this.animationPlaying = on && !! this.mixer;
		this._emit( 'animationchange' );

	}

	// ------------------------------------------------------------------ info

	getStats( root = this.model ) {

		const stats = { objects: 0, meshes: 0, vertices: 0, triangles: 0, materials: new Set(), textures: new Set() };
		if ( ! root ) return stats;

		root.traverse( ( child ) => {

			stats.objects ++;
			if ( ! child.isMesh ) return;
			stats.meshes ++;
			const g = child.geometry;
			const position = g.attributes.position;
			if ( position ) stats.vertices += position.count;
			stats.triangles += Math.floor( ( g.index ? g.index.count : ( position ? position.count : 0 ) ) / 3 );

			const mats = this.originalMaterials.get( child ) ?? child.material;

			for ( const m of Array.isArray( mats ) ? mats : [ mats ] ) {

				stats.materials.add( m );
				for ( const key of TEXTURE_KEYS ) if ( m[ key ] && m[ key ].isTexture ) stats.textures.add( m[ key ] );

			}

		} );

		return stats;

	}

	getSize( objects ) {

		const box = objects ? this._boxOf( objects ) : this.modelBox;
		return box && ! box.isEmpty() ? box.getSize( new THREE.Vector3() ) : new THREE.Vector3();

	}

	getOriginalMaterials( mesh ) {

		const mats = this.originalMaterials.get( mesh ) ?? mesh.material;
		return Array.isArray( mats ) ? mats : [ mats ];

	}

	screenshot() {

		this.composer.render();
		return this.renderer.domElement.toDataURL( 'image/png' );

	}

	// ------------------------------------------------------------------ loop

	_tick() {

		this.timer.update();
		const dt = this.timer.getDelta();
		const anim = this.cameraAnimation;

		if ( anim ) {

			const t = Math.min( 1, ( performance.now() - anim.start ) / anim.duration );
			const k = easeInOut( t );
			this.camera.position.lerpVectors( anim.fromPos, anim.toPos, k );
			this.controls.target.lerpVectors( anim.fromTarget, anim.toTarget, k );
			this.camera.zoom = THREE.MathUtils.lerp( anim.fromZoom, anim.toZoom, k );
			this.camera.updateProjectionMatrix();
			if ( t >= 1 ) this.cameraAnimation = null;

		}

		this.controls.update( dt );
		if ( this.mixer && this.animationPlaying ) this.mixer.update( dt );
		this._updateClipPlanes();
		this.composer.render();
		this.labelRenderer.render( this.scene, this.camera );

	}

	dispose() {

		this.renderer.setAnimationLoop( null );
		this._resizeObserver.disconnect();
		this.clearModel();
		this.controls.dispose();
		this.transform.dispose();
		this.composer.dispose();
		this.renderer.dispose();

	}

}

/** CPU copy of three.js' NeutralToneMapping (Khronos PBR Neutral), linear in / linear out. */
function neutralToneMap( rgb, exposure ) {

	const startCompression = 0.8 - 0.04;
	const desaturation = 0.15;
	let c = rgb.map( ( v ) => v * exposure );
	const x = Math.min( ...c );
	const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
	c = c.map( ( v ) => v - offset );
	const peak = Math.max( ...c );
	if ( peak < startCompression ) return c;
	const d = 1 - startCompression;
	const newPeak = 1 - ( d * d ) / ( peak + d - startCompression );
	c = c.map( ( v ) => v * newPeak / peak );
	const g = 1 - 1 / ( desaturation * ( peak - newPeak ) + 1 );
	return c.map( ( v ) => v + ( newPeak - v ) * g );

}

export function formatLength( value ) {

	const abs = Math.abs( value );
	if ( abs === 0 ) return '0';
	if ( abs >= 1000 ) return value.toFixed( 0 );
	if ( abs >= 10 ) return value.toFixed( 2 );
	if ( abs >= 0.01 ) return value.toFixed( 3 );
	return value.toExponential( 2 );

}
