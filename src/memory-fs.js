class MemoryStats {
	entry;

	constructor(entry) {
		this.entry = entry;
	}

	get size() {
		return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
	}

	get mtimeMs() {
		return this.entry.mtimeMs;
	}

	get ctimeMs() {
		return this.entry.mtimeMs;
	}

	get mode() {
		return this.entry.kind === "file" ? 0o100644 : 0o040000;
	}

	isFile() {
		return this.entry.kind === "file";
	}

	isDirectory() {
		return this.entry.kind === "dir";
	}

	isSymbolicLink() {
		return false;
	}
}

export class MemoryFS {
	encoder = new TextEncoder();
	decoder = new TextDecoder();
	entries = new Map([
		["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
	]);

	promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.lstat.bind(this),
		readlink: this.readlink.bind(this),
		symlink: this.symlink.bind(this),
	};

	normalize(input) {
		const segments = [];

		for (const part of input.split("/")) {
			if (!part || part === ".") {
				continue;
			}

			if (part === "..") {
				segments.pop();
				continue;
			}

			segments.push(part);
		}

		return `/${segments.join("/")}` || "/";
	}

	parent(path) {
		const normalized = this.normalize(path);
		if (normalized === "/") {
			return "/";
		}

		const parts = normalized.split("/").filter(Boolean);
		parts.pop();
		return parts.length ? `/${parts.join("/")}` : "/";
	}

	basename(path) {
		return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
	}

	getEntry(path) {
		return this.entries.get(this.normalize(path));
	}

	requireEntry(path) {
		const entry = this.getEntry(path);
		if (!entry) {
			const error = new Error(`ENOENT: ${path}`); error.code = 'ENOENT'; throw error;
		}

		return entry;
	}

	requireDir(path) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "dir") {
			throw new Error(`ENOTDIR: ${path}`);
		}

		return entry;
	}

	async mkdir(path, options) {
		const target = this.normalize(path);
		if (target === "/") {
			return;
		}

		const recursive =
			typeof options === "object" && options !== null && options.recursive;
		const parent = this.parent(target);

		if (!this.entries.has(parent)) {
			if (!recursive) {
				const error = new Error(`ENOENT: ${parent}`); error.code = 'ENOENT'; throw error;
			}

			await this.mkdir(parent, { recursive: true });
		}

		if (this.entries.has(target)) {
			return;
		}

		this.entries.set(target, {
			kind: "dir",
			children: new Set(),
			mtimeMs: Date.now(),
		});

		this.requireDir(parent).children.add(this.basename(target));
	}

	async writeFile(path, data) {
		const target = this.normalize(path);
		await this.mkdir(this.parent(target), { recursive: true });

		const bytes =
			typeof data === "string"
				? this.encoder.encode(data)
				: data instanceof Uint8Array
					? data
					: new Uint8Array(data);

		this.entries.set(target, {
			kind: "file",
			data: bytes,
			mtimeMs: Date.now(),
		});

		this.requireDir(this.parent(target)).children.add(this.basename(target));
	}

	async readFile(path, options) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "file") {
			throw new Error(`EISDIR: ${path}`);
		}

		const encoding = typeof options === "string" ? options : options?.encoding;
		return encoding ? this.decoder.decode(entry.data) : entry.data;
	}

	async readdir(path) {
		return [...this.requireDir(path).children].sort();
	}

	async unlink(path) {
		const target = this.normalize(path);
		const entry = this.requireEntry(target);
		if (entry.kind !== "file") {
			throw new Error(`EISDIR: ${path}`);
		}

		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async rmdir(path) {
		const target = this.normalize(path);
		const entry = this.requireDir(target);
		if (entry.children.size > 0) {
			throw new Error(`ENOTEMPTY: ${path}`);
		}

		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async stat(path) {
		return new MemoryStats(this.requireEntry(path));
	}

	async lstat(path) {
		return this.stat(path);
	}

	async readlink() { throw new Error('EINVAL: symlinks are not supported'); }
	async symlink() { throw new Error('EINVAL: symlinks are not supported'); }
}
