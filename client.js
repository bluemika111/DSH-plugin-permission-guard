window.__ModuleLoader__.load({
	id: "dsh-plugin-permission-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/**
		 * Client half: the outside-read SWITCH in the composer, and the state it mirrors.
		 *
		 * WHAT IT SHOWS. One boolean: may the model read outside the session workspace. That is the only
		 * thing the plugin decides. Writes are the harness sandbox's business and are deliberately not
		 * represented here — showing a write control would imply this plugin owns write access, which it
		 * does not.
		 *
		 * IT IS STILL READ-ONLY, AND THAT IS THE OPEN QUESTION, NOT AN OVERSIGHT. Flipping it needs a
		 * channel the MODEL cannot reach, because the model gaining outside reads is exactly the
		 * escalation this plugin exists to refuse. The read-only status route below is deliberately GET
		 * only: HTTP never passes through `tools/pre-execute`, so a write route would be reachable by the
		 * model's own shell and would route around the state file's fence. Candidate channels (a host
		 * method over the package-private client→host RPC, or the harness's own config editor) are not
		 * yet verified for a profile plugin, so this control reflects the setting and says how to change
		 * it, rather than pretending to be a working switch.
		 *
		 * The outer `__ModuleLoader__.load({ id, factory })` wrapper is REQUIRED, and `id` must equal the
		 * package name: a bundle that loads without calling the loader is rejected.
		 */

		const React = require("react");

		const SLOT = "conversation.input.left";
		const ENTRY_ID = "permission-guard.outside-read";
		const STATE_URL = "/permission-guard/state";

		/**
		 * Display strings, keyed by language. `outsideRead` is the state the switch reflects; `note`
		 * names only mechanisms that exist — an earlier version pointed at a tool the model cannot reach.
		 */
		const EN = {
			on: "Outside read",
			off: "Outside read",
			onDetail: "The model may read outside the workspace.",
			offDetail: "The model may not read outside the workspace.",
			note: "Read-only display. Change outsideRead in permissions.json beside the installed plugin; it applies immediately.",
			tooltip: "May the model read outside the session workspace?",
			readFailed: "Read failed: ",
			stateOn: "ON",
			stateOff: "OFF",
		};

		const ZH = {
			on: "外部读取",
			off: "外部读取",
			onDetail: "模型可以读取工作区之外的内容。",
			offDetail: "模型不能读取工作区之外的内容。",
			note: "只读显示。请修改插件旁 permissions.json 里的 outsideRead，改动立即生效。",
			tooltip: "模型是否可以读取会话工作区之外的内容？",
			readFailed: "读取失败：",
			stateOn: "开",
			stateOff: "关",
		};

		/** Prefix match, not equality: `zh-CN`, `zh-Hant` and a bare `zh` must all resolve to Chinese. */
		function dictFor(tag) {
			const value = typeof tag === "string" ? tag.toLowerCase() : "";
			if (value.indexOf("zh") === 0) return ZH;
			return EN;
		}

		/** Follow the harness locale when it is available, then the browser, then English. */
		function resolveDict(locale) {
			if (locale !== undefined && locale !== null) {
				try {
					const snapshot = locale.getSnapshot();
					if (snapshot !== undefined && snapshot !== null && typeof snapshot.active === "string") {
						return dictFor(snapshot.active);
					}
				} catch (error) { /* fall through */ }
			}
			try {
				if (typeof navigator !== "undefined" && navigator !== null) {
					const tagged = navigator.language || (navigator.languages && navigator.languages[0]);
					if (typeof tagged === "string") return dictFor(tagged);
				}
			} catch (error) { /* fall through */ }
			return EN;
		}

		const S = {
			wrap: { position: "relative", display: "inline-flex", alignItems: "center", gap: "6px" },
			label: { fontSize: "12px", lineHeight: "18px", whiteSpace: "nowrap" },
			button: {
				display: "inline-flex",
				alignItems: "center",
				gap: "6px",
				padding: "2px 8px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-border, rgba(128,128,128,0.35))",
				background: "transparent",
				color: "inherit",
				fontSize: "12px",
				lineHeight: "18px",
				cursor: "pointer",
				whiteSpace: "nowrap",
			},
			track: {
				position: "relative",
				display: "inline-block",
				width: "28px",
				height: "16px",
				borderRadius: "8px",
				transition: "background 120ms linear",
				flex: "0 0 auto",
			},
			knob: {
				position: "absolute",
				top: "2px",
				width: "12px",
				height: "12px",
				borderRadius: "50%",
				background: "var(--dsw-surface, Canvas)",
				transition: "left 120ms linear",
			},
			panel: {
				position: "absolute",
				bottom: "100%",
				left: 0,
				marginBottom: "6px",
				minWidth: "260px",
				padding: "8px 10px",
				borderRadius: "8px",
				border: "1px solid var(--dsw-border, rgba(128,128,128,0.35))",
				background: "var(--dsw-surface, Canvas)",
				color: "inherit",
				boxShadow: "0 6px 24px rgba(0,0,0,0.22)",
				zIndex: 40,
				fontSize: "12px",
				lineHeight: "17px",
			},
			detail: { display: "block", marginBottom: "4px" },
			note: { display: "block", opacity: 0.7, fontSize: "11px" },
			error: { display: "block", marginTop: "4px", fontSize: "11px", color: "var(--dsw-danger, #d33)" },
		};

		/**
		 * @param props.locale - the `locale` client service, or undefined. Undefined is supported: the
		 * control still renders, using `navigator` then English.
		 */
		function OutsideReadSwitch(props) {
			const locale = props && props.locale;
			const [state, setState] = React.useState({ ready: false, outsideRead: null, error: null });
			const [open, setOpen] = React.useState(false);
			// Bumped on a locale change to force a re-render; the active language is read during render
			// instead of being copied into state, so there is no stale copy.
			const [, setRevision] = React.useState(0);

			React.useEffect(() => {
				let alive = true;
				function load() {
					fetch(STATE_URL, { headers: { accept: "application/json" } })
						.then((response) => response.ok ? response.json() : Promise.reject(new Error("HTTP " + response.status)))
						.then((value) => {
							if (!alive) return;
							setState({
								ready: true,
								outsideRead: value && typeof value.outsideRead === "boolean" ? value.outsideRead : null,
								error: null,
							});
						})
						.catch((error) => {
							if (!alive) return;
							setState({ ready: true, outsideRead: null, error: String(error && error.message ? error.message : error) });
						});
				}
				load();
				// No push channel exists, so re-read when the window regains focus: the setting can change
				// while this page stays open.
				window.addEventListener("focus", load);
				return () => {
					alive = false;
					window.removeEventListener("focus", load);
				};
			}, []);

			React.useEffect(() => {
				if (locale === undefined || locale === null || typeof locale.subscribe !== "function") return undefined;
				let dispose = null;
				try {
					dispose = locale.subscribe(() => setRevision((n) => n + 1));
				} catch (error) {
					return undefined;
				}
				return typeof dispose === "function" ? dispose : undefined;
			}, [locale]);

			const t = resolveDict(locale);
			const isOn = state.outsideRead === true;
			const unknown = state.outsideRead === null;
			const trackStyle = Object.assign({}, S.track, {
				// The accent marks ON; the resting border marks OFF. Both come from theme tokens so the
				// control reads correctly in light and dark themes.
				background: unknown
					? "var(--dsw-border, rgba(128,128,128,0.35))"
					: (isOn ? "var(--dsw-accent, #3b82f6)" : "var(--dsw-border, rgba(128,128,128,0.35))"),
			});
			const knobStyle = Object.assign({}, S.knob, { left: isOn ? "14px" : "2px" });
			const stateText = unknown ? "…" : (isOn ? t.stateOn : t.stateOff);
			// Before the first answer — and whenever an answer cannot be obtained — say so plainly.
			// Concatenating a null error produced the literal text "Read failed: null", which reads as a
			// bug in the plugin rather than a state the user can act on.
			const detail = unknown
				? (state.error === null ? "…" : t.readFailed + state.error)
				: (isOn ? t.onDetail : t.offDetail);

			return React.createElement("div", { style: S.wrap },
				React.createElement("button", {
					type: "button",
					style: S.button,
					title: t.tooltip,
					// Expands an explanation rather than switching: this control is read-only, and a click
					// that silently did nothing would read as a bug.
					onClick: () => setOpen(!open),
				},
					React.createElement("span", { style: S.label }, t.on),
					React.createElement("span", { style: trackStyle }, React.createElement("span", { style: knobStyle })),
					React.createElement("span", null, stateText)),
				open ? React.createElement("div", { style: S.panel },
					React.createElement("span", { style: S.detail }, detail),
					React.createElement("span", { style: S.note }, t.note),
					state.error !== null && state.outsideRead !== null
						? React.createElement("span", { style: S.error }, t.readFailed + state.error)
						: null,
				) : null,
			);
		}

		/**
		 * Surface a client-side failure on the page. A silent no-op is indistinguishable from "not
		 * registered", "not applied" and "applied but the slot never resolved", so the failure says which.
		 */
		function reportFailure(headline, detail) {
			try {
				const existing = document.getElementById("permission-guard-diag");
				if (existing !== null) existing.remove();
				const box = document.createElement("div");
				box.id = "permission-guard-diag";
				box.setAttribute("style", [
					"position:fixed", "left:8px", "bottom:8px", "z-index:2147483647",
					"max-width:520px", "padding:8px 10px", "border-radius:6px",
					"background:#7f1d1d", "color:#fff", "font:12px/1.5 monospace",
					"white-space:pre-wrap", "box-shadow:0 4px 16px rgba(0,0,0,0.4)",
				].join(";"));
				box.textContent = "[permission-guard] " + headline + "\n" + detail;
				document.body.appendChild(box);
			} catch (error) {
				// Nothing further we can do; never throw from the reporter.
			}
		}

		/**
		 * Client-SERVICE dependencies, by Cordis service name. These two faces are not interchangeable:
		 * `exports.inject` takes SERVICE names and decides what is attached to this plugin's ctx, while
		 * `package.json` `dsh.client.inject` takes PACKAGE names and only orders loading.
		 */
		const inject = ["slots", "locale"];

		function apply(ctx) {
			try {
				const slots = ctx.get("slots");
				if (slots === undefined) {
					reportFailure(
						"ctx.get(\"slots\") returned undefined",
						"the bundle loaded and apply() ran, but the slots service is not attached to this plugin's context.\ndeclared inject: " + JSON.stringify(inject));
					return;
				}
				const locale = ctx.get("locale");
				if (locale === undefined) {
					// Not fatal, and deliberately not silent: the control still works, but it will not follow
					// a live language switch.
					console.warn("[permission-guard] locale service unavailable; language follows navigator only");
				}
				console.log("[permission-guard] apply() ran; slots service found. Waiting for " + SLOT + " ...");
				slots.inject(SLOT, () => {
					console.log("[permission-guard] slot " + SLOT + " declared; registering...");
					const dispose = slots.register({ name: SLOT, id: ENTRY_ID, order: 5 }, (slotProps) => {
						const merged = Object.assign({}, slotProps, { locale: locale });
						return React.createElement(OutsideReadSwitch, merged);
					});
					console.log("[permission-guard] registered into " + SLOT);
					return dispose;
				});
			} catch (error) {
				reportFailure("apply() threw", String(error && error.stack ? error.stack : error));
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
