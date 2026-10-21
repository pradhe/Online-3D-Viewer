import { runMetaJob, runUsdJob } from './usdJob.js';

// One job per worker: the page terminates the worker when the job is done or cancelled.
self.onmessage = async ( { data } ) => {

	try {

		const progress = ( text ) => self.postMessage( { type: 'progress', text } );
		const { result, transfer } = data.job === 'meta' ? await runMetaJob( data.spec ) : await runUsdJob( data.spec, { onProgress: progress } );
		self.postMessage( { type: 'done', result }, transfer );

	} catch ( error ) {

		self.postMessage( { type: 'error', error: { name: error?.name, message: String( error?.message ?? error ), hint: error?.hint || '' } } );

	}

};
