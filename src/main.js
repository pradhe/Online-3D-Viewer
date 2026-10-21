import { Viewer, VIEWS, RENDER_MODES, formatLength } from './viewer.js';
import { ENVIRONMENTS } from './environments.js';
import { TONE_MAPPINGS } from './toneMapping.js';
import { loadFromFiles, loadFromURL, baseName } from './loaders.js';
import { exportModel, EXPORT_FORMATS } from './exporters.js';
import { attachUsdPaths } from './usdMetadata.js';
import { Editor } from './editor.js';
import { formatError, webglAvailable } from './errors.js';
import { reportError, reportingAvailable, reportingEnabled, setReportingEnabled } from './reporting.js';

const $ = ( sel ) => document.querySelector( sel );
const $$ = ( sel ) => [ ...document.querySelectorAll( sel ) ];

const SAMPLES = {
	city: { url: 'samples/city/city.obj', label: 'Low-poly city' },
	shapes: { url: 'samples/shapes/shapes.usda', label: 'Shapes' },
};

const SETTINGS_KEY = 'mycity-viewer:settings:v2';
const DEFAULTS = {
	renderMode: 'shaded',
	background: '#1d2127',
	grid: true,
	axes: false,
	bounds: false,
	shadows: true,
	ao: true,
	environment: 'studio',
	toneMapping: 'neutral',
	envRotation: 0,
	doubleSided: false,
	light: 1,
	env: 1,
	exposure: 1,
	fov: 45,
};

if ( ! webglAvailable() ) {

	$( '#viewport' ).innerHTML = '<div class="fatal"><h2>3D graphics are not available</h2><p>This viewer needs WebGL 2. Turn on hardware acceleration in your browser settings, update your browser or graphics driver, or try another browser.</p></div>';
	throw new Error( 'WebGL 2 is not available' );

}

const viewer = new Viewer( $( '#viewport' ) );
window.viewer = viewer; // handy for debugging from the console

const state = { file: null, usdObjects: new Map() };

const editor = new Editor( {
	viewer,
	state,
	toast: ( ...a ) => toast( ...a ),
	onChange: () => {

		renderSelection();
		updateEditCount();

	},
} );

// ======================================================================= utils

function escapeHtml( s ) {

	return String( s ).replace( /[&<>"']/g, ( c ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ c ] ) );

}

function formatBytes( n ) {

	if ( ! n && n !== 0 ) return '—';
	const units = [ 'B', 'KB', 'MB', 'GB' ];
	let i = 0;
	while ( n >= 1024 && i < units.length - 1 ) {

		n /= 1024;
		i ++;

	}

	return `${ n.toFixed( i ? 1 : 0 ) } ${ units[ i ] }`;

}

const fmtInt = ( n ) => n.toLocaleString();
const nextFrame = () => new Promise( ( r ) => requestAnimationFrame( () => r() ) );

function download( blob, filename ) {

	const url = URL.createObjectURL( blob );
	const a = document.createElement( 'a' );
	a.href = url;
	a.download = filename;
	document.body.appendChild( a );
	a.click();
	a.remove();
	setTimeout( () => URL.revokeObjectURL( url ), 1000 );

}

function modelStem() {

	const name = state.file ? state.file.name : 'model';
	return name.replace( /\.[^.]+$/, '' ) || 'model';

}

function toast( message, type = 'info', timeout = 5000 ) {

	const el = document.createElement( 'div' );
	el.className = `toast ${ type }`;
	el.setAttribute( 'role', type === 'error' ? 'alert' : 'status' );
	el.innerHTML = `<p></p><button aria-label="Dismiss"><svg><use href="#i-x"/></svg></button>`;
	el.querySelector( 'p' ).textContent = message;
	const close = () => el.remove();
	el.querySelector( 'button' ).addEventListener( 'click', close );
	$( '#toasts' ).appendChild( el );
	if ( timeout ) setTimeout( close, timeout );

}

function showLoading( text ) {

	$( '#loading-text' ).textContent = text;
	$( '#loading-cancel' ).hidden = ! activeLoad;
	$( '#loading' ).hidden = false;

}

function hideLoading() {

	$( '#loading' ).hidden = true;

}

// ======================================================================= settings

function loadSettings() {

	try {

		return { ...DEFAULTS, ...JSON.parse( localStorage.getItem( SETTINGS_KEY ) || '{}' ) };

	} catch {

		return { ...DEFAULTS };

	}

}

let settings = loadSettings();

function saveSettings() {

	try {

		localStorage.setItem( SETTINGS_KEY, JSON.stringify( settings ) );

	} catch {

		// storage unavailable (private mode etc.) – settings just won't persist

	}

}

function applySettings() {

	const s = settings;
	if ( ! RENDER_MODES[ s.renderMode ] ) s.renderMode = 'shaded';

	if ( ! ENVIRONMENTS[ s.environment ] ) s.environment = 'studio';
	if ( ! TONE_MAPPINGS[ s.toneMapping ] ) s.toneMapping = 'neutral';
	$( '#opt-render-mode' ).value = s.renderMode;
	$( '#opt-environment' ).value = s.environment;
	$( '#opt-tonemapping' ).value = s.toneMapping;
	$( '#opt-ao' ).checked = s.ao;
	$( '#opt-envrot' ).value = s.envRotation;
	$( '#opt-background' ).value = s.background;
	$( '#opt-grid' ).checked = s.grid;
	$( '#opt-axes' ).checked = s.axes;
	$( '#opt-bounds' ).checked = s.bounds;
	$( '#opt-shadows' ).checked = s.shadows;
	$( '#opt-double' ).checked = s.doubleSided;
	$( '#opt-light' ).value = s.light;
	$( '#opt-env' ).value = s.env;
	$( '#opt-exposure' ).value = s.exposure;
	$( '#opt-fov' ).value = s.fov;

	viewer.setToneMapping( s.toneMapping );
	viewer.setEnvironment( s.environment );
	viewer.setEnvironmentRotation( s.envRotation );
	viewer.setAmbientOcclusion( s.ao );
	viewer.setRenderMode( s.renderMode );
	viewer.setBackground( s.background );
	$( '#viewport' ).style.background = s.background;
	viewer.setGridVisible( s.grid );
	viewer.setAxesVisible( s.axes );
	viewer.setBoundsVisible( s.bounds );
	viewer.setShadows( s.shadows );
	viewer.setDoubleSided( s.doubleSided );
	viewer.setLightIntensity( s.light );
	viewer.setEnvironmentIntensity( s.env );
	viewer.setExposure( s.exposure );
	viewer.setFov( s.fov );
	updateOutputs();

}

function updateOutputs() {

	$( '#out-light' ).textContent = Number( settings.light ).toFixed( 2 );
	$( '#out-env' ).textContent = Number( settings.env ).toFixed( 2 );
	$( '#out-exposure' ).textContent = Number( settings.exposure ).toFixed( 2 );
	$( '#out-fov' ).textContent = `${ settings.fov }°`;
	$( '#out-envrot' ).textContent = `${ settings.envRotation }°`;

}

function setSetting( key, value ) {

	settings[ key ] = value;
	saveSettings();
	applySettings();

}

// ======================================================================= loading

let activeLoad = null;

function cancelLoad() {

	activeLoad?.abort();

}

$( '#loading-cancel' ).addEventListener( 'click', cancelLoad );
window.addEventListener( 'keydown', ( e ) => {

	if ( e.key === 'Escape' && activeLoad ) cancelLoad();

} );

async function runLoad( label, loader ) {

	const controller = new AbortController();
	activeLoad = controller;
	const started = performance.now();
	const elapsed = setInterval( () => {

		const s = Math.round( ( performance.now() - started ) / 1000 );
		$( '#loading-elapsed' ).textContent = s >= 3 ? `${ s } s · press Esc or Cancel to stop` : '';

	}, 1000 );

	showLoading( `Loading ${ label }…` );
	// Let the overlay paint before heavy synchronous parsing starts.
	await nextFrame();
	await nextFrame();
	const t0 = performance.now();

	try {

		const result = await loader( controller.signal );
		if ( controller.signal.aborted ) throw new DOMException( 'Cancelled', 'AbortError' );
		viewer.upAxis = 'y';
		$( '#opt-up' ).value = 'y';
		state.file = { ...result, loadMs: performance.now() - t0 };
		state.usdObjects = new Map();
		if ( result.usd ) {

			attachUsdPaths( result.object, result.usd );
			result.object.traverse( ( o ) => {

				if ( ! o.userData.usdPath ) return;
				state.usdObjects.set( o.userData.usdPath, o );

				// The loader leaves materials unnamed; use the bound USD material's name.
				const binding = result.usd.prims.get( o.userData.usdPath )?.relationships.find( ( r ) => r.name === 'material:binding' );
				const target = binding?.targets[ 0 ];
				if ( o.isMesh && target ) {

					for ( const m of Array.isArray( o.material ) ? o.material : [ o.material ] ) {

						if ( ! m.name ) m.name = target.split( '/' ).pop();

					}

				}

			} );

		}

		editor.reset();
		viewer.setModel( result.object );
		updateEditCount();
		document.body.classList.add( 'has-model' );
		$( '#empty-state' ).hidden = true;
		document.title = `${ result.name } · MyCity 3D Viewer`;
		result.warnings.forEach( ( w ) => toast( w, 'info', 10000 ) );
		return true;

	} catch ( e ) {

		if ( e?.name === 'AbortError' ) {

			toast( 'Loading cancelled.', 'info', 3000 );
			return false;

		}

		console.error( e );
		toast( `Could not open ${ label }. ${ formatError( e ) }`, 'error', 12000 );
		if ( e?.name !== 'ViewerError' ) reportError( e, 'load' );
		return false;

	} finally {

		clearInterval( elapsed );
		$( '#loading-elapsed' ).textContent = '';
		if ( activeLoad === controller ) activeLoad = null;
		hideLoading();

	}

}

function setQuery( params ) {

	const url = new URL( window.location.href );
	url.search = new URLSearchParams( params ).toString();
	history.replaceState( null, '', url );

}

const rootDialog = $( '#root-dialog' );

/** Asks which USD file to open when a folder has several at the top level. */
function chooseRoot( candidates ) {

	return new Promise( ( resolve ) => {

		hideLoading();
		const list = $( '#root-list' );
		list.innerHTML = '';

		for ( const c of candidates ) {

			const b = document.createElement( 'button' );
			b.type = 'button';
			b.className = 'root-option';
			b.innerHTML = `<span></span><small>${ formatBytes( c.size ) }</small>`;
			b.querySelector( 'span' ).textContent = c.path;
			b.addEventListener( 'click', () => {

				rootDialog.returnValue = 'picked';
				rootDialog.close();
				showLoading( `Loading ${ c.name }…` );
				resolve( c );

			} );
			list.appendChild( b );

		}

		rootDialog.addEventListener( 'close', () => {

			if ( rootDialog.returnValue !== 'picked' ) resolve( null );

		}, { once: true } );
		rootDialog.returnValue = '';
		rootDialog.showModal();

	} );

}

async function openFiles( files ) {

	if ( ! files.length ) return;
	const label = files.length === 1 ? files[ 0 ].name : `${ files.length } files`;
	const options = { chooseRoot, onProgress: ( text ) => showLoading( text ) };
	if ( await runLoad( label, ( signal ) => loadFromFiles( files, { ...options, signal } ) ) ) setQuery( {} );

}

async function openURL( url ) {

	if ( await runLoad( baseName( url ), ( signal ) => loadFromURL( url, { onProgress: showLoading, signal } ) ) ) setQuery( { model: url } );

}

async function openSample( key ) {

	const sample = SAMPLES[ key ];
	if ( ! sample ) return;
	const url = new URL( sample.url, new URL( import.meta.env.BASE_URL, window.location.href ) ).href;
	if ( await runLoad( sample.label, ( signal ) => loadFromURL( url, { onProgress: showLoading, signal } ) ) ) setQuery( { sample: key } );

}

// ---- file picker

const fileInput = $( '#file-input' );
// No `accept` filter: several browsers (iOS, Android, some desktops) don't know .usd/.usda/.usdc
// and grey those files out. Unsupported files get a clear error after picking instead.
fileInput.addEventListener( 'change', () => {

	openFiles( [ ...fileInput.files ] );
	fileInput.value = '';

} );
$( '#btn-open' ).addEventListener( 'click', () => fileInput.click() );

const folderInput = $( '#folder-input' );
folderInput.addEventListener( 'change', () => {

	openFiles( [ ...folderInput.files ] );
	folderInput.value = '';

} );
$( '#btn-open-folder' ).addEventListener( 'click', () => folderInput.click() );
$$( '[data-action="open-folder"]' ).forEach( ( b ) => b.addEventListener( 'click', () => folderInput.click() ) );
$$( '[data-action="open"]' ).forEach( ( b ) => b.addEventListener( 'click', () => fileInput.click() ) );
$$( '[data-sample]' ).forEach( ( b ) => b.addEventListener( 'click', () => {

	closeMenus();
	openSample( b.dataset.sample );

} ) );

// ---- URL dialog

const urlDialog = $( '#url-dialog' );
$( '#btn-url' ).addEventListener( 'click', () => {

	urlDialog.showModal();
	$( '#url-input' ).select();

} );
urlDialog.addEventListener( 'close', () => {

	if ( urlDialog.returnValue === 'ok' ) openURL( $( '#url-input' ).value.trim() );

} );

// ---- drag & drop (files and folders)

function hasFiles( e ) {

	return e.dataTransfer && [ ...e.dataTransfer.types ].includes( 'Files' );

}

function readEntry( entry ) {

	if ( entry.isFile ) {

		return new Promise( ( resolve ) => entry.file( ( f ) => {

			// Keep the folder structure: USD scenes reference files by relative path.
			f.relativePath = entry.fullPath.replace( /^\//, '' );
			resolve( [ f ] );

		}, () => resolve( [] ) ) );

	}

	return new Promise( ( resolve ) => {

		const reader = entry.createReader();
		const all = [];
		const next = () => reader.readEntries( async ( batch ) => {

			if ( ! batch.length ) {

				const nested = await Promise.all( all.map( readEntry ) );
				resolve( nested.flat() );
				return;

			}

			all.push( ...batch );
			next();

		}, () => resolve( [] ) );
		next();

	} );

}

async function filesFromDrop( dt ) {

	// Entries must be grabbed synchronously, before the first await.
	const entries = [ ...( dt.items || [] ) ].map( ( i ) => i.webkitGetAsEntry && i.webkitGetAsEntry() ).filter( Boolean );
	const plain = [ ...dt.files ];
	if ( ! entries.length ) return plain;
	return ( await Promise.all( entries.map( readEntry ) ) ).flat();

}

let dragDepth = 0;
window.addEventListener( 'dragenter', ( e ) => {

	if ( ! hasFiles( e ) ) return;
	e.preventDefault();
	dragDepth ++;
	document.body.classList.add( 'dragging' );

} );
window.addEventListener( 'dragleave', () => {

	dragDepth = Math.max( 0, dragDepth - 1 );
	if ( ! dragDepth ) document.body.classList.remove( 'dragging' );

} );
window.addEventListener( 'dragover', ( e ) => {

	if ( ! hasFiles( e ) ) return;
	e.preventDefault();
	e.dataTransfer.dropEffect = 'copy';

} );
window.addEventListener( 'drop', async ( e ) => {

	if ( ! hasFiles( e ) ) return;
	e.preventDefault();
	dragDepth = 0;
	document.body.classList.remove( 'dragging' );
	openFiles( await filesFromDrop( e.dataTransfer ) );

} );

// ======================================================================= menus

function closeMenus( except ) {

	$$( 'details.menu[open]' ).forEach( ( d ) => {

		if ( d !== except ) d.open = false;

	} );

}

document.addEventListener( 'click', ( e ) => {

	const menu = e.target.closest( 'details.menu' );
	closeMenus( menu );

} );

const exportList = $( '#export-list' );
for ( const [ key, fmt ] of Object.entries( EXPORT_FORMATS ) ) {

	const b = document.createElement( 'button' );
	b.innerHTML = `${ escapeHtml( fmt.label ) } <small>.${ key }</small>`;
	b.addEventListener( 'click', () => {

		closeMenus();
		runExport( key );

	} );
	exportList.appendChild( b );

}

{

	const b = document.createElement( 'button' );
	b.className = 'menu-sep-before';
	b.innerHTML = 'USD edits layer <small>.usda</small>';
	b.title = 'Your changes as a small USD file that layers over the original';
	b.addEventListener( 'click', () => {

		closeMenus();
		runExport( 'usdedits' );

	} );
	exportList.appendChild( b );

}

function exportUsdEdits() {

	if ( ! state.file?.usd ) {

		toast( 'The USD edits layer is for USD files. For other models, export GLB or USDZ to keep your changes.', 'info', 7000 );
		return;

	}

	const layer = editor.buildUsdEditLayer();

	if ( ! layer ) {

		toast( 'There are no changes to save yet. Edit a colour, transform or property first.', 'info', 6000 );
		return;

	}

	download( new Blob( [ layer.text ], { type: 'text/plain' } ), `${ modelStem() }_edits.usda` );
	toast( `Saved ${ modelStem() }_edits.usda. Keep it in the same folder as ${ state.file.name } and open the edits file in any USD app.`, 'success', 9000 );
	if ( layer.skipped.length ) toast( `Transform changes on animated objects were not saved: ${ layer.skipped.join( ', ' ) }`, 'info', 9000 );

}

async function runExport( format ) {

	if ( ! viewer.model ) return;
	if ( format === 'usdedits' ) return exportUsdEdits();
	showLoading( `Exporting ${ format.toUpperCase() }…` );
	await nextFrame();

	try {

		const blob = await exportModel( viewer.model, format, ( n ) => viewer.originalMaterials.get( n ) ?? n.material );
		download( blob, `${ modelStem() }.${ format }` );
		toast( `Exported ${ modelStem() }.${ format } (${ formatBytes( blob.size ) })`, 'success', 4000 );

	} catch ( e ) {

		console.error( e );
		toast( `Export failed: ${ e.message || e }`, 'error', 10000 );

	} finally {

		hideLoading();

	}

}

$( '#btn-screenshot' ).addEventListener( 'click', async () => {

	const dataUrl = viewer.screenshot();
	const blob = await ( await fetch( dataUrl ) ).blob();
	download( blob, `${ modelStem() }-screenshot.png` );

} );

$( '#btn-fullscreen' ).addEventListener( 'click', () => {

	if ( document.fullscreenElement ) document.exitFullscreen();
	else document.documentElement.requestFullscreen?.().catch( () => toast( 'Fullscreen is not available here.' ) );

} );

const helpDialog = $( '#help-dialog' );
$( '#btn-help' ).addEventListener( 'click', () => helpDialog.showModal() );

// ---- panels (mobile)

$( '#toggle-left' ).addEventListener( 'click', () => {

	document.body.classList.toggle( 'show-left' );
	document.body.classList.remove( 'show-right' );

} );
$( '#toggle-right' ).addEventListener( 'click', () => {

	document.body.classList.toggle( 'show-right' );
	document.body.classList.remove( 'show-left' );

} );
$( '#viewport' ).addEventListener( 'pointerdown', () => document.body.classList.remove( 'show-left', 'show-right' ) );

// ======================================================================= scene tree

const treeEl = $( '#tree' );
const rows = new Map(); // Object3D -> { row, eye, caret, children, depth, built, open }
const searchInput = $( '#tree-search' );

function labelOf( o ) {

	return o.name || o.type;

}

function iconOf( o ) {

	if ( o.isMesh ) return 'i-mesh';
	if ( o.isLight ) return 'i-light';
	if ( o.isCamera ) return 'i-camera';
	return o.children.length ? 'i-group' : 'i-dot';

}

function createRow( obj, depth, { flat = false } = {} ) {

	const wrap = document.createElement( 'div' );
	const row = document.createElement( 'div' );
	row.className = 'tree-row';
	row.setAttribute( 'role', 'treeitem' );
	row.style.paddingLeft = `${ 4 + depth * 14 }px`;

	const hasKids = ! flat && obj.children.length > 0;
	row.innerHTML = `
		<button class="tree-caret ${ hasKids ? '' : 'leaf' }" tabindex="-1" aria-label="Expand"><svg><use href="#i-chevron"/></svg></button>
		<svg class="tree-icon"><use href="#${ iconOf( obj ) }"/></svg>
		<span class="tree-name"></span>
		<button class="tree-eye" title="Show / hide" aria-label="Toggle visibility"><svg><use href="#i-eye"/></svg></button>`;
	const name = row.querySelector( '.tree-name' );
	name.textContent = labelOf( obj );
	name.title = labelOf( obj );

	const children = document.createElement( 'div' );
	children.hidden = true;
	wrap.append( row, children );

	const entry = { row, eye: row.querySelector( '.tree-eye use' ), caret: row.querySelector( '.tree-caret' ), children, depth, built: false, open: false };
	rows.set( obj, entry );

	entry.caret.addEventListener( 'click', ( e ) => {

		e.stopPropagation();
		setExpanded( obj, ! entry.open );

	} );
	row.querySelector( '.tree-eye' ).addEventListener( 'click', ( e ) => {

		e.stopPropagation();
		viewer.setVisible( [ obj ], ! obj.visible );

	} );
	row.addEventListener( 'click', ( e ) => viewer.select( [ obj ], { toggle: e.shiftKey || e.ctrlKey || e.metaKey } ) );
	row.addEventListener( 'dblclick', () => viewer.focus( [ obj ] ) );

	syncRowVisibility( obj, entry );
	return wrap;

}

function setExpanded( obj, open ) {

	const entry = rows.get( obj );
	if ( ! entry || ! obj.children.length ) return;

	if ( open && ! entry.built ) {

		const frag = document.createDocumentFragment();
		obj.children.forEach( ( c ) => frag.appendChild( createRow( c, entry.depth + 1 ) ) );
		entry.children.appendChild( frag );
		entry.built = true;

	}

	entry.open = open;
	entry.children.hidden = ! open;
	entry.caret.classList.toggle( 'open', open );

}

function syncRowVisibility( obj, entry = rows.get( obj ) ) {

	if ( ! entry ) return;
	entry.row.classList.toggle( 'hidden-obj', ! obj.visible );
	entry.eye.setAttribute( 'href', obj.visible ? '#i-eye' : '#i-eye-off' );

}

function buildTree() {

	treeEl.innerHTML = '';
	rows.clear();
	const model = viewer.model;

	if ( ! model ) {

		treeEl.innerHTML = '<div class="tree-empty">No model loaded.</div>';
		$( '#tree-count' ).textContent = '';
		return;

	}

	const query = searchInput.value.trim().toLowerCase();

	if ( query ) {

		const matches = [];
		model.traverse( ( o ) => {

			if ( o !== model && labelOf( o ).toLowerCase().includes( query ) ) matches.push( o );

		} );
		const shown = matches.slice( 0, 500 );
		shown.forEach( ( o ) => treeEl.appendChild( createRow( o, 0, { flat: true } ) ) );
		if ( ! matches.length ) treeEl.innerHTML = '<div class="tree-empty">No matches.</div>';
		$( '#tree-count' ).textContent = `${ matches.length } found`;

	} else {

		treeEl.appendChild( createRow( model, 0 ) );
		// Auto-expand the first levels while they are small.
		let level = [ model ];
		for ( let d = 0; d < 3 && level.length === 1; d ++ ) {

			setExpanded( level[ 0 ], true );
			level = level[ 0 ].children;

		}

		let count = 0;
		model.traverse( () => count ++ );
		$( '#tree-count' ).textContent = `${ fmtInt( count ) } objects`;

	}

	syncTreeSelection( false );

}

function syncTreeSelection( scroll = true ) {

	rows.forEach( ( e ) => e.row.classList.remove( 'selected' ) );
	let first = null;

	for ( const obj of viewer.selection ) {

		if ( ! searchInput.value.trim() ) {

			// Expand ancestors so the row exists.
			const chain = [];
			for ( let p = obj.parent; p && p !== viewer.pivot; p = p.parent ) chain.unshift( p );
			chain.forEach( ( p ) => setExpanded( p, true ) );

		}

		const entry = rows.get( obj );

		if ( entry ) {

			entry.row.classList.add( 'selected' );
			first = first || entry.row;

		}

	}

	if ( scroll && first ) first.scrollIntoView( { block: 'nearest' } );

}

let searchTimer;
searchInput.addEventListener( 'input', () => {

	clearTimeout( searchTimer );
	searchTimer = setTimeout( buildTree, 150 );

} );

$( '#btn-show-all' ).addEventListener( 'click', () => viewer.showAll() );
$( '#btn-collapse' ).addEventListener( 'click', () => {

	searchInput.value = '';
	treeEl.innerHTML = '';
	rows.clear();
	if ( viewer.model ) {

		treeEl.appendChild( createRow( viewer.model, 0 ) );
		setExpanded( viewer.model, true );

	}

} );

// ======================================================================= selection panel

const selectionBody = $( '#selection-body' );

function fmtVec( v ) {

	return [ v.x, v.y, v.z ].map( ( n ) => formatLength( n ) ).join( ', ' );

}

function materialRow( { material: m, count } ) {

	const color = m.color ? `#${ m.color.getHexString() }` : 'transparent';
	const tags = [];
	if ( m.map ) tags.push( 'texture' );
	if ( m.transparent && m.opacity < 1 ) tags.push( `α ${ m.opacity.toFixed( 2 ) }` );
	const type = m.type.replace( /^Mesh|Material$/g, '' );
	return `<li><span class="chip" style="background:${ color }"></span><span>${ escapeHtml( m.name || '(unnamed)' ) }${ count > 1 ? ` <span class="muted">×${ count }</span>` : '' }</span><small>${ escapeHtml( [ type, ...tags ].join( ' · ' ) ) }</small></li>`;

}

// ======================================================================= USD stage

function renderUsdStage() {

	const meta = state.file?.usd;
	$( '#section-usd-stage' ).hidden = ! meta;
	if ( ! meta ) return;
	$( '#usd-stage' ).innerHTML = [
		...meta.stage.map( ( [ k, v ] ) => `<dt>${ escapeHtml( k ) }</dt><dd>${ escapeHtml( v ) }</dd>` ),
		`<dt>prims</dt><dd>${ fmtInt( meta.prims.size ) }</dd>`,
	].join( '' );

}

function renderSelection() {

	const sel = [ ...viewer.selection ];

	if ( ! sel.length ) {

		selectionBody.innerHTML = '<p class="muted">Click an object in the view or the scene tree.<br/>Shift / Ctrl + click to select several.</p>';
		return;

	}

	let vertices = 0;
	let triangles = 0;
	const materials = new Set();

	for ( const o of sel ) {

		const s = viewer.getStats( o );
		vertices += s.vertices;
		triangles += s.triangles;
		s.materials.forEach( ( m ) => materials.add( m ) );

	}

	const size = viewer.getSize( sel );
	const single = sel.length === 1 ? sel[ 0 ] : null;
	const anyVisible = sel.some( ( o ) => o.visible );
	// Loaders often create one material per part; list identical ones once.
	const groups = new Map();
	for ( const m of materials ) {

		const key = [ m.name, m.type, m.color?.getHexString(), m.map?.uuid, m.opacity ].join( '|' );
		if ( groups.has( key ) ) groups.get( key ).count ++;
		else groups.set( key, { material: m, count: 1 } );

	}

	const mats = [ ...groups.values() ];

	selectionBody.innerHTML = `
		<div>
			<div class="sel-title">${ escapeHtml( single ? labelOf( single ) : `${ sel.length } objects` ) }</div>
			<div class="sel-type">${ escapeHtml( single ? single.type : 'Multiple selection' ) }</div>
		</div>
		<dl class="props">
			<dt>Vertices</dt><dd>${ fmtInt( vertices ) }</dd>
			<dt>Triangles</dt><dd>${ fmtInt( triangles ) }</dd>
			${ single && single.children.length ? `<dt>Children</dt><dd>${ fmtInt( single.children.length ) }</dd>` : '' }
			<dt>Size</dt><dd>${ fmtVec( size ) }</dd>
		</dl>
		<div class="button-row">
			<button class="btn small" data-act="focus">Focus</button>
			<button class="btn small" data-act="hide">${ anyVisible ? 'Hide' : 'Show' }</button>
			<button class="btn small" data-act="isolate">Isolate</button>
			<button class="btn small" data-act="deselect">Deselect</button>
		</div>
		${ mats.length ? `<div class="sub-label">Materials (${ materials.size })</div><ul class="materials">${ mats.slice( 0, 8 ).map( materialRow ).join( '' ) }${ mats.length > 8 ? `<li class="muted">+ ${ mats.length - 8 } more</li>` : '' }</ul>` : '' }
		${ editor.appearanceSection( sel ) }
		${ single ? editor.transformSection( single ) : '' }
		${ single ? `
		<div class="button-row gizmo-row">
			<div class="seg" id="gizmo-seg">
				<button data-gizmo="" title="Off (Q)">Off</button>
				<button data-gizmo="translate" title="Move (W)">Move</button>
				<button data-gizmo="rotate" title="Rotate (E)">Rotate</button>
				<button data-gizmo="scale" title="Scale (R)">Scale</button>
			</div>
			<button class="btn small" data-act="reset" title="Undo transform changes">Reset</button>
		</div>` : '' }
		${ single ? editor.usdSection( single ) : '' }`;

	editor.wireAppearance( selectionBody, sel );
	if ( single ) {

		editor.wireTransform( selectionBody, single );
		editor.wireProperties( selectionBody, single );

	}

	selectionBody.querySelectorAll( '[data-act]' ).forEach( ( b ) => b.addEventListener( 'click', () => {

		const act = b.dataset.act;
		if ( act === 'focus' ) viewer.focus();
		if ( act === 'hide' ) viewer.setVisible( sel, ! anyVisible );
		if ( act === 'isolate' ) viewer.isolate();
		if ( act === 'deselect' ) viewer.clearSelection();
		if ( act === 'reset' ) {

			viewer.resetTransform();
			renderSelection();
			updateEditCount();

		}

	} ) );

	selectionBody.querySelectorAll( '[data-gizmo]' ).forEach( ( b ) => b.addEventListener( 'click', () => viewer.setGizmoMode( b.dataset.gizmo || null ) ) );
	syncGizmoButtons();

}

function syncGizmoButtons() {

	selectionBody.querySelectorAll( '[data-gizmo]' ).forEach( ( b ) => {

		b.classList.toggle( 'active', ( b.dataset.gizmo || null ) === viewer.gizmoMode );

	} );

}

// ======================================================================= model info

function renderModelInfo() {

	const el = $( '#model-info' );
	const f = state.file;

	if ( ! viewer.model || ! f ) {

		el.innerHTML = '<dt>—</dt><dd class="muted">No model loaded</dd>';
		return;

	}

	const s = viewer.getStats();
	const size = viewer.getSize();
	el.innerHTML = `
		<dt>File</dt><dd>${ escapeHtml( f.name ) }</dd>
		<dt>Format</dt><dd>${ escapeHtml( f.format.toUpperCase() ) }</dd>
		${ f.layers > 1 ? `<dt>USD layers</dt><dd>${ fmtInt( f.layers ) }</dd>` : '' }
		<dt>File size</dt><dd>${ formatBytes( f.size ) }</dd>
		<dt>Objects</dt><dd>${ fmtInt( s.objects ) }</dd>
		<dt>Meshes</dt><dd>${ fmtInt( s.meshes ) }</dd>
		<dt>Vertices</dt><dd>${ fmtInt( s.vertices ) }</dd>
		<dt>Triangles</dt><dd>${ fmtInt( s.triangles ) }</dd>
		<dt>Materials</dt><dd>${ fmtInt( s.materials.size ) }</dd>
		<dt>Textures</dt><dd>${ fmtInt( s.textures.size ) }</dd>
		<dt>Dimensions</dt><dd>${ formatLength( size.x ) } × ${ formatLength( size.y ) } × ${ formatLength( size.z ) }</dd>
		${ viewer.model.animations?.length ? `<dt>Animations</dt><dd>${ viewer.model.animations.length }</dd>` : '' }
		<dt>Load time</dt><dd>${ ( f.loadMs / 1000 ).toFixed( 2 ) } s</dd>
		${ f.missing?.length ? `<dt class="missing-head">Missing files</dt><dd class="missing-count">${ f.missing.length }</dd>
		<dd class="missing-list"><textarea readonly rows="${ Math.min( 8, f.missing.length ) }" aria-label="Missing files">${ escapeHtml( f.missing.join( '\n' ) ) }</textarea></dd>` : '' }`;

}

function renderAnimation() {

	const clips = viewer.model?.animations || [];
	$( '#section-animation' ).hidden = ! clips.length;
	if ( ! clips.length ) return;
	$( '#anim-clip' ).innerHTML = clips.map( ( c, i ) => `<option value="${ i }">${ escapeHtml( c.name || `Clip ${ i + 1 }` ) } (${ c.duration.toFixed( 1 ) }s)</option>` ).join( '' );
	$( '#anim-toggle' ).textContent = viewer.animationPlaying ? 'Pause' : 'Play';

}

$( '#anim-clip' ).addEventListener( 'change', ( e ) => viewer.playAnimation( Number( e.target.value ) ) );
$( '#anim-toggle' ).addEventListener( 'click', () => viewer.setAnimationPlaying( ! viewer.animationPlaying ) );

// ======================================================================= display controls

const renderModeSelect = $( '#opt-render-mode' );
renderModeSelect.innerHTML = Object.entries( RENDER_MODES ).map( ( [ k, v ] ) => `<option value="${ k }">${ v }</option>` ).join( '' );
renderModeSelect.addEventListener( 'change', () => setSetting( 'renderMode', renderModeSelect.value ) );

$( '#opt-background' ).addEventListener( 'input', ( e ) => setSetting( 'background', e.target.value ) );
$$( '[data-bg]' ).forEach( ( b ) => b.addEventListener( 'click', () => setSetting( 'background', b.dataset.bg ) ) );

const checkMap = { 'opt-grid': 'grid', 'opt-axes': 'axes', 'opt-bounds': 'bounds', 'opt-shadows': 'shadows', 'opt-double': 'doubleSided', 'opt-ao': 'ao' };

$( '#opt-environment' ).innerHTML = Object.entries( ENVIRONMENTS ).map( ( [ k, v ] ) => `<option value="${ k }">${ v }</option>` ).join( '' );
$( '#opt-tonemapping' ).innerHTML = Object.entries( TONE_MAPPINGS ).map( ( [ k, v ] ) => `<option value="${ k }">${ escapeHtml( v.label ) }</option>` ).join( '' );
$( '#opt-environment' ).addEventListener( 'change', ( e ) => setSetting( 'environment', e.target.value ) );
$( '#opt-tonemapping' ).addEventListener( 'change', ( e ) => setSetting( 'toneMapping', e.target.value ) );
for ( const [ id, key ] of Object.entries( checkMap ) ) {

	$( `#${ id }` ).addEventListener( 'change', ( e ) => setSetting( key, e.target.checked ) );

}

const rangeMap = { 'opt-light': 'light', 'opt-env': 'env', 'opt-exposure': 'exposure', 'opt-fov': 'fov', 'opt-envrot': 'envRotation' };
for ( const [ id, key ] of Object.entries( rangeMap ) ) {

	$( `#${ id }` ).addEventListener( 'input', ( e ) => setSetting( key, Number( e.target.value ) ) );

}

$( '#opt-up' ).addEventListener( 'change', ( e ) => viewer.setUpAxis( e.target.value ) );
$( '#btn-reset-display' ).addEventListener( 'click', () => {

	settings = { ...DEFAULTS };
	saveSettings();
	applySettings();

} );

function setAutoRotate( on ) {

	viewer.setAutoRotate( on );
	$( '#opt-autorotate' ).checked = on;
	$( '#btn-autorotate' ).classList.toggle( 'active', on );

}

$( '#opt-autorotate' ).addEventListener( 'change', ( e ) => setAutoRotate( e.target.checked ) );
$( '#btn-autorotate' ).addEventListener( 'click', () => setAutoRotate( ! viewer.controls.autoRotate ) );

// ======================================================================= view toolbar

$( '#btn-fit' ).addEventListener( 'click', () => viewer.focus() );
$$( '[data-view]' ).forEach( ( b ) => b.addEventListener( 'click', () => viewer.setView( b.dataset.view ) ) );

function toggleProjection() {

	viewer.setProjection( viewer.camera.isOrthographicCamera ? 'perspective' : 'orthographic' );

}

$( '#btn-projection' ).addEventListener( 'click', toggleProjection );
viewer.addEventListener( 'projectionchange', () => {

	const ortho = viewer.camera.isOrthographicCamera;
	$( '#btn-projection' ).textContent = ortho ? 'Ortho' : 'Persp';
	$( '#btn-projection' ).classList.toggle( 'active', ortho );

} );

$( '#btn-measure' ).addEventListener( 'click', () => viewer.setMeasuring( ! viewer.measuring ) );
$( '#btn-measure-clear' ).addEventListener( 'click', () => viewer.clearMeasurements() );

viewer.addEventListener( 'measurechange', () => {

	$( '#btn-measure' ).classList.toggle( 'active', viewer.measuring );
	$( '#measure-hud' ).hidden = ! viewer.measuring;
	$( '#measure-list' ).innerHTML = viewer.measurements.map( ( m, i ) => `<li>#${ i + 1 }&nbsp; ${ formatLength( m.distance ) }</li>` ).join( '' );

} );

// ======================================================================= viewer events

viewer.addEventListener( 'modelchange', () => {

	searchInput.value = '';
	buildTree();
	renderSelection();
	renderModelInfo();
	renderAnimation();
	renderUsdStage();

} );

viewer.addEventListener( 'selectionchange', () => {

	syncTreeSelection();
	renderSelection();

} );

viewer.addEventListener( 'visibilitychange', () => {

	rows.forEach( ( entry, obj ) => syncRowVisibility( obj, entry ) );
	renderSelection();

} );

viewer.addEventListener( 'gizmochange', syncGizmoButtons );
viewer.addEventListener( 'animationchange', () => {

	$( '#anim-toggle' ).textContent = viewer.animationPlaying ? 'Pause' : 'Play';

} );

let transformQueued = false;
viewer.addEventListener( 'transformchange', () => {

	if ( transformQueued ) return;
	transformQueued = true;
	requestAnimationFrame( () => {

		transformQueued = false;
		const [ obj ] = viewer.selection;
		editor.syncTransformInputs( selectionBody, obj );
		updateEditCount();

	} );

} );

// ======================================================================= edits

function updateEditCount() {

	const n = viewer.model ? editor.editCount() : 0;
	const badge = $( '#edit-count' );
	badge.hidden = ! n;
	badge.textContent = n;
	badge.title = `${ n } unsaved change${ n === 1 ? '' : 's' }`;

}

window.addEventListener( 'beforeunload', ( e ) => {

	if ( viewer.model && editor.editCount() ) {

		e.preventDefault();
		e.returnValue = '';

	}

} );

// ======================================================================= keyboard

window.addEventListener( 'keydown', ( e ) => {

	const target = e.target;
	if ( target.closest && target.closest( 'input, select, textarea, dialog' ) ) return;

	if ( ( e.ctrlKey || e.metaKey ) && e.key.toLowerCase() === 'o' ) {

		e.preventDefault();
		fileInput.click();
		return;

	}

	if ( e.ctrlKey || e.metaKey || e.altKey ) return;

	const key = e.key.toLowerCase();
	const viewKeys = [ 'front', 'back', 'left', 'right', 'top', 'bottom', 'iso' ];

	if ( key === '?' ) return helpDialog.showModal();
	if ( ! viewer.model ) return;

	if ( /^[1-7]$/.test( key ) ) return viewer.setView( viewKeys[ Number( key ) - 1 ] );

	switch ( key ) {

		case 'f': viewer.focus(); break;
		case 'p': toggleProjection(); break;
		case 'g': setSetting( 'grid', ! settings.grid ); break;
		case 'm': viewer.setMeasuring( ! viewer.measuring ); break;
		case 'h': if ( viewer.selection.size ) viewer.setVisible( [ ...viewer.selection ], false ); break;
		case 'i': viewer.isolate(); break;
		case 'u': viewer.showAll(); break;
		case 'w': viewer.setGizmoMode( 'translate' ); break;
		case 'e': viewer.setGizmoMode( 'rotate' ); break;
		case 'r': viewer.setGizmoMode( 'scale' ); break;
		case 'q': viewer.setGizmoMode( null ); break;
		case 'escape':
			if ( viewer.measuring ) viewer.setMeasuring( false );
			else if ( viewer.gizmoMode ) viewer.setGizmoMode( null );
			else viewer.clearSelection();
			break;
		default: return;

	}

	e.preventDefault();

} );

// Any user input may change what is drawn (settings, edits, gizmo drags): ask for fresh frames.
for ( const type of [ 'pointerdown', 'pointerup', 'wheel', 'keydown', 'input', 'change', 'click' ] ) {

	window.addEventListener( type, () => viewer.invalidate(), { capture: true, passive: true } );

}

window.addEventListener( 'pointermove', ( e ) => {

	if ( e.buttons ) viewer.invalidate();

}, { capture: true, passive: true } );

// ======================================================================= start

applySettings();
buildTree();
renderSelection();

const params = new URLSearchParams( window.location.search );
if ( params.get( 'model' ) ) openURL( params.get( 'model' ) );
else if ( SAMPLES[ params.get( 'sample' ) ] ) openSample( params.get( 'sample' ) );

// ================================================================ error handling

let lastCrashToast = 0;

/** Anything that slips past a specific handler: tell the user once in a while, and report if allowed. */
function onUnexpected( error ) {

	const text = String( error?.message || error || '' );
	if ( /ResizeObserver loop/.test( text ) ) return; // harmless browser notice
	console.error( error );
	reportError( error, 'uncaught' );

	if ( Date.now() - lastCrashToast < 30000 ) return;
	lastCrashToast = Date.now();
	toast( 'Something went wrong. Your model is still open; if the view looks wrong, reload the page.', 'error', 8000 );

}

window.addEventListener( 'error', ( e ) => onUnexpected( e.error || e.message ) );
window.addEventListener( 'unhandledrejection', ( e ) => onUnexpected( e.reason ) );

viewer.addEventListener( 'contextlost', () => toast( 'The graphics context was lost, so the view went blank. It should come back by itself; if not, reload the page.', 'error', 10000 ) );
viewer.addEventListener( 'contextrestored', () => toast( 'Graphics restored.', 'success', 3000 ) );

if ( reportingAvailable ) {

	const row = $( '#report-row' );
	const box = $( '#opt-report' );
	row.hidden = false;
	box.checked = reportingEnabled();
	box.addEventListener( 'change', () => setReportingEnabled( box.checked ) );

}
