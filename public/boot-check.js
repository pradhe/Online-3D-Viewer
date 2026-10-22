/*
 * Runs before the app. If the app fails to start (a script that did not load, an error while
 * starting, an unsupported browser) the toolbar would be dead with no explanation, so this puts
 * the reason on screen. The app sets window.__viewerReady once it has wired everything up.
 */
( function () {

	var shown = false;

	function show( message ) {

		if ( shown || window.__viewerReady ) return;
		shown = true;

		var box = document.createElement( 'div' );
		box.id = 'boot-error';
		box.setAttribute( 'role', 'alert' );
		box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;background:#3a1d1d;color:#ffd7d7;border:1px solid #a33;border-radius:8px;padding:12px 14px;font:13px/1.45 system-ui,sans-serif;max-height:45vh;overflow:auto';

		var title = document.createElement( 'strong' );
		title.textContent = 'The viewer could not start.';
		var detail = document.createElement( 'div' );
		detail.textContent = message;
		var hint = document.createElement( 'div' );
		hint.style.opacity = '.8';
		hint.textContent = 'Try reloading with Ctrl+Shift+R (Cmd+Shift+R on a Mac). If it keeps happening, send this message with your browser name and version. ' + ( navigator.userAgent || '' );

		box.appendChild( title );
		box.appendChild( detail );
		box.appendChild( hint );
		( document.body || document.documentElement ).appendChild( box );

	}

	// Capture phase also sees scripts and stylesheets that failed to load.
	window.addEventListener( 'error', function ( e ) {

		if ( window.__viewerReady ) return;
		var target = e.target;

		if ( target && target !== window && ( target.src || target.href ) ) show( 'A file failed to load: ' + ( target.src || target.href ) );
		else show( String( ( e.error && e.error.message ) || e.message || 'Unknown error' ) + ( e.filename ? ' (' + e.filename.split( '/' ).pop() + ':' + e.lineno + ')' : '' ) );

	}, true );

	window.addEventListener( 'unhandledrejection', function ( e ) {

		if ( ! window.__viewerReady ) show( String( ( e.reason && e.reason.message ) || e.reason ) );

	} );

	setTimeout( function () {

		if ( ! window.__viewerReady ) show( 'It did not finish starting within 10 seconds.' );

	}, 10000 );

}() );
