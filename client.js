window.__ModuleLoader__.load({
	id: "dsh-outsideread-switch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/**
		 * Client half: the outside-read SWITCH in the composer.
		 *
		 * WHAT IT SHOWS. One boolean: may the model read outside the session workspace. That is the only
		 * thing this plugin decides. Writes are the harness sandbox's business and are deliberately not
		 * represented — a write control here would imply this plugin owns write access, which it does not.
		 *
		 * HOW IT WRITES, AND WHY THIS WAY. A click runs the host command `/outside-read on|off`, reached
		 * through the session's own `command(line)`. That choice IS the security design:
		 *
		 *   - An HTTP write route would fail by construction. HTTP never passes `tools/pre-execute`, so the
		 *     model's own shell could POST to it and route around the fence protecting the state file.
		 *   - A command is the harness's HUMAN-command registry. The model cannot type a slash command, and
		 *     this plugin invents no route of its own.
		 *   - The residual assumption, stated rather than buried: the connection RPC carrying the command
		 *     is the same channel the harness's OWN permission selector uses, so anything able to drive it
		 *     could already change the built-in sandbox preset. This adds no new class of exposure — but it
		 *     is not a stronger barrier either.
		 *
		 * The read path stays separate and boring: after the command settles the switch re-reads the
		 * read-only status route. A failed read is shown, never guessed.
		 *
		 * The outer `__ModuleLoader__.load({ id, factory })` wrapper is REQUIRED, and `id` must equal the
		 * package name: a bundle that loads without calling the loader is rejected.
		 */

		const React = require("react");

		const SLOT = "conversation.input.left";
		const ENTRY_ID = "outsideread-switch.outside-read";
		const STATE_URL = "/outsideread-switch/state";
		const COMMAND = "/outside-read";

		/** Display strings. `note` names only mechanisms that exist AND still apply. */
		const EN = {
			label: "Outside read",
			onDetail: "The model may read outside the workspace.",
			offDetail: "The model may not read outside the workspace.",
			note: "Click to switch. The change goes through a host command the model cannot issue; editing permissions.json beside the plugin also works.",
			tooltip: "May the model read outside the session workspace? Click to switch.",
			readFailed: "Read failed: ",
			commandFailed: "Switch failed: ",
			noSessions: "the sessions client service is not attached to this plugin",
			noBindingApi: "the sessions service has no binding() method",
			noSessionId: "the slot supplied no sessionId",
			bindingMissing: "sessions.binding() returned nothing; the session may not be retained yet",
			bindingThrew: "sessions.binding() threw: ",
			noCommand: "the binding exposes no session.command() method",
			stateOn: "ON",
			stateOff: "OFF",
			unknown: "…",
			working: "…",
		};

		const ZH = {
			label: "外部读取",
			onDetail: "模型可以读取工作区之外的内容。",
			offDetail: "模型不能读取工作区之外的内容。",
			note: "点击切换。改动通过宿主命令写入，模型无法发起；也可以直接编辑插件旁的 permissions.json。",
			tooltip: "模型是否可以读取会话工作区之外的内容？点击切换。",
			readFailed: "读取失败：",
			commandFailed: "切换失败：",
			noSessions: "本插件没有挂上 sessions 客户端服务",
			noBindingApi: "sessions 服务没有 binding() 方法",
			noSessionId: "槽位没有提供 sessionId",
			bindingMissing: "sessions.binding() 返回空；该会话可能还没被保留",
			bindingThrew: "sessions.binding() 抛错：",
			noCommand: "该绑定上没有 session.command() 方法",
			stateOn: "开",
			stateOff: "关",
			unknown: "…",
			working: "…",
		};

		/** Prefix match, not equality: `zh-CN`, `zh-Hant` and a bare `zh` must all resolve to Chinese. */
		function dictFor(tag) {
			const value = typeof tag === "string" ? tag.toLowerCase() : "";
			if (value.indexOf("zh") === 0) return ZH;
			return EN;
		}

		/** Follow the harness locale when available, then the browser, then English. */
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
			buttonBusy: { opacity: 0.6, cursor: "progress" },
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
				minWidth: "280px",
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
		 * @param props.getService - resolves a client service BY NAME AT CALL TIME. This is a function
		 *                           rather than resolved values on purpose; see the note below.
		 * @param props.sessionId  - the session id supplied by the slot; the command is issued against it.
		 *
		 * WHY SERVICES ARE RESOLVED LAZILY, AND THIS IS NOT STYLE.
		 *
		 * The first version read `ctx.get("sessions")` once inside `apply()` and closed over the result.
		 * That made a RACE permanent: if the service registered after this plugin mounted, the `undefined`
		 * was captured forever and the switch could never work again, no matter how long the page stayed
		 * open. It showed up exactly as a race does — working in one shell and failing in another, because
		 * the two order their client services differently. Desktop worked; the browser failed with
		 * "the sessions client service is not attached".
		 *
		 * Resolving during render costs a property lookup and removes the failure mode entirely: whenever
		 * the service does arrive, the next render sees it.
		 */
		function OutsideReadSwitch(props) {
			const getService = props && props.getService;
			const read = typeof getService === "function"
				? getService
				: function () { return undefined; };
			const locale = read("locale");
			const sessions = read("sessions");
			const sessionId = props && props.sessionId;
			const [state, setState] = React.useState({ ready: false, outsideRead: null, error: null });
			const [busy, setBusy] = React.useState(false);
			const [open, setOpen] = React.useState(false);
			const [commandError, setCommandError] = React.useState(null);
			// Bumped on a locale change to force a re-render; the active language is read during render
			// rather than copied into state, so there is no stale copy.
			const [, setRevision] = React.useState(0);

			function readState() {
				return fetch(STATE_URL, { headers: { accept: "application/json" } })
					.then((response) => response.ok ? response.json() : Promise.reject(new Error("HTTP " + response.status)))
					.then((value) => {
						setState({
							ready: true,
							outsideRead: value && typeof value.outsideRead === "boolean" ? value.outsideRead : null,
							error: null,
						});
					})
					.catch((error) => {
						setState({ ready: true, outsideRead: null, error: String(error && error.message ? error.message : error) });
					});
			}

			React.useEffect(() => {
				function load() { readState(); }
				load();
				// No push channel exists, so re-read when the window regains focus: the setting can change
				// while this page stays open.
				window.addEventListener("focus", load);
				return () => { window.removeEventListener("focus", load); };
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

			/**
			 * Flip the setting by running the host command, then re-read.
			 *
			 * The command's own success text is NOT surfaced: `command(line)` resolves to whether the line
			 * matched, not to the handler's result. So the re-read is what tells the truth, and a command
			 * that silently did nothing shows up as an unchanged switch instead of a confident message.
			 */
			/**
			 * Report WHY the switch could not act.
			 *
			 * One generic "cannot switch" was the first version, and it is useless on a live machine: it
			 * cannot distinguish a missing service from a missing prop from an unretained session, and those
			 * need different fixes. Each step below names itself so the control doubles as its own diagnosis.
			 */
			function fail(reason) {
				setCommandError(t.commandFailed + " " + reason);
				setOpen(true);
			}

			function toggle() {
				if (busy) return;
				setCommandError(null);
				if (unknown) { setOpen(true); return; }
				if (sessions === undefined || sessions === null) { fail(t.noSessions); return; }
				if (typeof sessions.binding !== "function") { fail(t.noBindingApi); return; }
				if (sessionId === undefined || sessionId === null || sessionId === "") { fail(t.noSessionId); return; }
				let binding = null;
				try {
					binding = sessions.binding(sessionId);
				} catch (error) {
					fail(t.bindingThrew + String(error && error.message ? error.message : error));
					return;
				}
				if (binding === undefined || binding === null) { fail(t.bindingMissing); return; }
				if (binding.session === undefined || binding.session === null
					|| typeof binding.session.command !== "function") { fail(t.noCommand); return; }
				const wanted = !isOn;
				setBusy(true);
				Promise.resolve(binding.session.command(COMMAND + " " + (wanted ? "on" : "off")))
					.then(() => readState())
					.catch((error) => {
						setCommandError(t.commandFailed + String(error && error.message ? error.message : error));
						setOpen(true);
					})
					.then(() => setBusy(false));
			}

			const trackStyle = Object.assign({}, S.track, {
				// The accent marks ON; the resting border marks OFF. Both are theme tokens so the control
				// reads correctly in light and dark themes.
				background: unknown
					? "var(--dsw-border, rgba(128,128,128,0.35))"
					: (isOn ? "var(--dsw-accent, #2196f3)" : "var(--dsw-border, rgba(128,128,128,0.35))"),
			});
			const knobStyle = Object.assign({}, S.knob, { left: isOn ? "14px" : "2px" });
			const stateText = busy ? t.working : (unknown ? t.unknown : (isOn ? t.stateOn : t.stateOff));
			// Before the first answer, and whenever no answer can be obtained, say so plainly. Concatenating
			// a null error once produced the literal text "Read failed: null", which reads as a bug in the
			// plugin rather than as a state the user can act on.
			const detail = unknown
				? (state.error === null ? t.unknown : t.readFailed + state.error)
				: (isOn ? t.onDetail : t.offDetail);
			const buttonStyle = busy ? Object.assign({}, S.button, S.buttonBusy) : S.button;

			return React.createElement("div", { style: S.wrap },
				React.createElement("button", {
					type: "button",
					style: buttonStyle,
					title: t.tooltip,
					// The click IS the switch. Holding the explanation behind a second gesture would make the
					// control look like a display again — which is what it used to be, and why it looked broken.
					onClick: toggle,
					// The explanation stays reachable without competing with the switch: right-click reveals it.
					onContextMenu: (event) => { event.preventDefault(); setOpen(!open); },
				},
					React.createElement("span", { style: S.label }, t.label),
					React.createElement("span", { style: trackStyle }, React.createElement("span", { style: knobStyle })),
					React.createElement("span", null, stateText)),
				(open || commandError !== null) ? React.createElement("div", { style: S.panel },
					React.createElement("span", { style: S.detail }, detail),
					React.createElement("span", { style: S.note }, t.note),
					state.error !== null && state.outsideRead !== null
						? React.createElement("span", { style: S.error }, t.readFailed + state.error)
						: null,
					commandError !== null
						? React.createElement("span", { style: S.error }, commandError)
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
				const existing = document.getElementById("outsideread-switch-diag");
				if (existing !== null) existing.remove();
				const box = document.createElement("div");
				box.id = "outsideread-switch-diag";
				box.setAttribute("style", [
					"position:fixed", "left:8px", "bottom:8px", "z-index:2147483647",
					"max-width:520px", "padding:8px 10px", "border-radius:6px",
					"background:#7f1d1d", "color:#fff", "font:12px/1.5 monospace",
					"white-space:pre-wrap", "box-shadow:0 4px 16px rgba(0,0,0,0.4)",
				].join(";"));
				box.textContent = "[outsideread-switch] " + headline + "\n" + detail;
				document.body.appendChild(box);
			} catch (error) {
				// Nothing further we can do; never throw from the reporter.
			}
		}

		/**
		 * Client-SERVICE dependencies, by Cordis service name. These two faces are not interchangeable:
		 * `exports.inject` takes SERVICE names and decides what is attached to this plugin's ctx, while
		 * `package.json` `dsh.client.inject` takes PACKAGE names and only orders loading.
		 *
		 * `sessions` is deliberately NOT here, even though the switch needs it. A declared dependency is a
		 * HARD one: `apply()` would not run until the service appears, so on a build without it the whole
		 * control would vanish silently — the exact failure mode this plugin keeps having to fix. It is
		 * fetched with `ctx.get("sessions")` and an undefined check instead, and a control that cannot
		 * switch says so rather than disappearing.
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

				/**
				 * Resolve a service by name, now.
				 *
				 * Deliberately NOT called once here and captured: that is what broke the switch in the
				 * browser while it worked on Desktop. Services can register after this plugin mounts, and a
				 * captured `undefined` is permanent.
				 */
				function getService(name) {
					try {
						return ctx.get(name);
					} catch (error) {
						return undefined;
					}
				}

				// Logged ONCE at mount for diagnosis, but never used as the switch's source: the switch asks
				// again at render time. A warning here therefore means "not yet", not "never".
				const atMount = getService("sessions");
				if (atMount === undefined) {
					console.warn("[outsideread-switch] sessions service is not registered yet at mount time; the"
						+ " switch resolves it lazily at render time and will pick it up when it appears");
				}
				if (getService("locale") === undefined) {
					console.warn("[outsideread-switch] locale service unavailable; language follows navigator only");
				}

				console.log("[outsideread-switch] apply() ran; slots service found. Waiting for " + SLOT + " ...");
				slots.inject(SLOT, () => {
					console.log("[outsideread-switch] slot " + SLOT + " declared; registering...");
					const dispose = slots.register({ name: SLOT, id: ENTRY_ID, order: 5 }, (slotProps) => {
						const merged = Object.assign({}, slotProps, { getService: getService });
						return React.createElement(OutsideReadSwitch, merged);
					});
					console.log("[outsideread-switch] registered into " + SLOT);
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
