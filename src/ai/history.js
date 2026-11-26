/**
 * Undo stack for changes made by the assistant (the first piece of the ROADMAP's action layer).
 * Each entry: { label, undo(), discard?() } — discard frees what undo would have needed.
 */
export class History {

	constructor( limit = 50 ) {

		this.limit = limit;
		this.entries = [];

	}

	get size() {

		return this.entries.length;

	}

	push( entry ) {

		this.entries.push( entry );
		while ( this.entries.length > this.limit ) this.entries.shift().discard?.();

	}

	/** Reverts the newest change; returns its label, or null when there is nothing to undo. */
	undo() {

		const entry = this.entries.pop();
		if ( ! entry ) return null;
		entry.undo();
		return entry.label;

	}

	clear() {

		for ( const entry of this.entries ) entry.discard?.();
		this.entries = [];

	}

}
