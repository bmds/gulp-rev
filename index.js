'use strict';
const path = require('path');
const gutil = require('gulp-util');
const through = require('through2');
const vinylFile = require('vinyl-file');
const revHash = require('rev-hash');
const revPath = require('rev-path');
const sortKeys = require('sort-keys');
const modifyFilename = require('modify-filename');

let manifestObject = {};

function relPath(base, filePath) {
	if (filePath.indexOf(base) !== 0) {
		return filePath.replace(/\\/g, '/');
	}

	const newPath = filePath.slice(base.length).replace(/\\/g, '/');

	if (newPath[0] === '/') {
		return newPath.slice(1);
	}

	return newPath;
}

function transformFilename(file) {
	// Save the old path for later
	file.revOrigPath = file.path;
	file.revOrigBase = file.base;
	file.revHash = revHash(file.contents);

	file.path = modifyFilename(file.path, (filename, extension) => {
		const extIndex = filename.indexOf('.');

		filename = extIndex === -1 ?
			revPath(filename, file.revHash) :
			revPath(filename.slice(0, extIndex), file.revHash) + filename.slice(extIndex);

		return filename + extension;
	});
}

const getManifestFile = opts => vinylFile.read(opts.path, opts).catch(err => {
	if (err.code === 'ENOENT') {
		return new gutil.File(opts);
	}

	throw err;
});

function addStreamFileToManifest(file, manifest) {
	const revisionedFile = relPath(file.base, file.path);
	const originalFile = path.join(path.dirname(revisionedFile), path.basename(file.revOrigPath)).replace(/\\/g, '/');

	manifest[originalFile] = revisionedFile;
}

function mergeManifest(manifestFile, manifest, transformer) {
	let oldManifest = {};

	try {
		oldManifest = transformer.parse(manifestFile.contents.toString());
	} catch (err) {}

	return Object.assign(oldManifest, manifest);
}

const isRevedFile = file => file.path && file.revOrigPath;

const plugin = () => {
	const sourcemaps = [];
	const pathMap = {};

	return through.obj((file, enc, cb) => {
		if (file.isNull()) {
			cb(null, file);
			return;
		}

		if (file.isStream()) {
			cb(new gutil.PluginError('gulp-rev', 'Streaming not supported'));
			return;
		}

		// This is a sourcemap, hold until the end
		if (path.extname(file.path) === '.map') {
			sourcemaps.push(file);
			cb();
			return;
		}

		const oldPath = file.path;
		transformFilename(file);
		pathMap[oldPath] = file.revHash;

		cb(null, file);
	}, function (cb) {
		sourcemaps.forEach(file => {
			let reverseFilename;

			// Attempt to parse the sourcemap's JSON to get the reverse filename
			try {
				reverseFilename = JSON.parse(file.contents.toString()).file;
			} catch (err) {}

			if (!reverseFilename) {
				reverseFilename = path.relative(path.dirname(file.path), path.basename(file.path, '.map'));
			}

			if (pathMap[reverseFilename]) {
				// Save the old path for later
				file.revOrigPath = file.path;
				file.revOrigBase = file.base;

				const hash = pathMap[reverseFilename];
				file.path = revPath(file.path.replace(/\.map$/, ''), hash) + '.map';
			} else {
				transformFilename(file);
			}

			this.push(file);
		});

		cb();
	});
};

plugin.manifest = (pth, opts) => {
	if (typeof pth === 'string') {
		pth = {path: pth};
	}

	opts = Object.assign({
		path: 'rev-manifest.json',
		merge: false,
		transformer: JSON
	}, opts, pth);

	let manifest = {};

	return through.obj((file, enc, cb) => {
		// Ignore all non-rev'd files
		if (!file.path || !file.revOrigPath) {
			cb();
			return;
		}

		addStreamFileToManifest(file, manifest);

		cb();
	}, function (cb) {
		// No need to write a manifest file if there's nothing to manifest
		if (Object.keys(manifest).length === 0) {
			cb();
			return;
		}

		getManifestFile(opts).then(manifestFile => {
			if (opts.merge && !manifestFile.isNull()) {
				manifest = mergeManifest(manifestFile, manifest, opts.transformer);
			}

			manifestFile.contents = Buffer.from(opts.transformer.stringify(sortKeys(manifest), null, '  '));
			this.push(manifestFile);
			cb();
		}).catch(cb);
	});
};

plugin.manifestObj = () => {
	return through.obj((file, enc, cb) => {
		// ignore all non-rev'd files
		if (!isRevedFile(file)) {
			cb();
			return;
		}

		addStreamFileToManifest(file, manifestObject);
		cb();
	});
};

plugin.manifestMerge = function (opts) {
	opts = Object.assign({
		transformer: JSON
	}, opts);

	return through.obj(function (file, enc, cb) {
		manifestObject = mergeManifest(file, manifestObject, opts.transformer);

		file.contents = Buffer.from(opts.transformer.stringify(sortKeys(manifestObject), null, '  '));
		this.push(file);
		cb();
	});
};

module.exports = plugin;
