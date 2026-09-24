// Generated from tui.tsx by scripts/build-tui.ts. Do not edit.
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
// Sidebar block for opencode-octopi: the session's workers (state, model, cost) and the tree's
// running slots and cost, pushed live from the server plugin over RPC. A worker finishing toasts.
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Definition } from "./rpc.ts";
const usd = value => value < 0.01 && value > 0 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
const shortModel = model => model.slice(model.indexOf("/") + 1).replace(/^claude-/, "");
export default Plugin.define({
  id: "opencode-octopi.sidebar",
  setup(context) {
    const rpc = context.client.rpc(Definition);
    const [fleets, setFleets] = createSignal({});
    const store = snap => setFleets(all => ({
      ...all,
      [snap.leaderID]: snap
    }));
    const off = rpc.events.on("update", event => {
      const snap = event.data;
      store(snap);
      if (snap.notice) context.ui.toast.show({
        variant: "info",
        message: `octopi: ${snap.notice}`,
        sessionID: snap.leaderID
      });
    });
    function Block(props) {
      const theme = context.theme;
      const fleet = createMemo(() => fleets()[props.sessionID]);

      // Fetch once per session shown; later changes arrive as events.
      createEffect(on(() => props.sessionID, sessionID => {
        const location = context.data.session.get(sessionID)?.location;
        rpc.fleet({
          sessionID
        }, location ? {
          location
        } : undefined).then(result => result && store(result)).catch(() => {});
      }));
      const color = state => state === "running" ? theme.text.feedback.success.base : state === "closed" ? theme.text.muted : theme.text.base;
      return _$createComponent(Show, {
        get when() {
          return _$memo(() => !!fleet())() && fleet().workers.length > 0;
        },
        get children() {
          var _el$ = _$createElement("box"),
            _el$2 = _$createElement("text"),
            _el$3 = _$createElement("b"),
            _el$5 = _$createElement("text"),
            _el$6 = _$createTextNode(`/`),
            _el$7 = _$createTextNode(` running · tree `);
          _$insertNode(_el$, _el$2);
          _$insertNode(_el$, _el$5);
          _$insertNode(_el$2, _el$3);
          _$insertNode(_el$3, _$createTextNode(`Workers`));
          _$insert(_el$, _$createComponent(For, {
            get each() {
              return fleet().workers;
            },
            children: w => (() => {
              var _el$8 = _$createElement("text"),
                _el$9 = _$createTextNode(` `),
                _el$0 = _$createTextNode(` `),
                _el$1 = _$createElement("span"),
                _el$10 = _$createTextNode(` `);
              _$insertNode(_el$8, _el$9);
              _$insertNode(_el$8, _el$0);
              _$insertNode(_el$8, _el$1);
              _$insert(_el$8, (() => {
                var _c$ = _$memo(() => w.state === "running");
                return () => _c$() ? "▶" : _$memo(() => w.state === "closed")() ? "✕" : w.unreported ? "●" : "○";
              })(), _el$9);
              _$insert(_el$8, () => w.name, _el$0);
              _$insertNode(_el$1, _el$10);
              _$insert(_el$1, () => shortModel(w.model), _el$10);
              _$insert(_el$1, () => usd(w.cost), null);
              _$insert(_el$1, (() => {
                var _c$2 = _$memo(() => w.contextPercent !== undefined);
                return () => _c$2() ? ` ${w.contextPercent}%` : "";
              })(), null);
              _$effect(_p$ => {
                var _v$3 = color(w.state),
                  _v$4 = {
                    fg: theme.text.muted
                  };
                _v$3 !== _p$.e && (_p$.e = _$setProp(_el$8, "fg", _v$3, _p$.e));
                _v$4 !== _p$.t && (_p$.t = _$setProp(_el$1, "style", _v$4, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$8;
            })()
          }), _el$5);
          _$insertNode(_el$5, _el$6);
          _$insertNode(_el$5, _el$7);
          _$insert(_el$5, () => fleet().running, _el$6);
          _$insert(_el$5, () => fleet().maxRunning, _el$7);
          _$insert(_el$5, () => usd(fleet().treeCost), null);
          _$effect(_p$ => {
            var _v$ = theme.text.base,
              _v$2 = theme.text.muted;
            _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
            _v$2 !== _p$.t && (_p$.t = _$setProp(_el$5, "fg", _v$2, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$;
        }
      });
    }
    const release = context.ui.slot({
      append: "sidebar.content",
      render: props => _$createComponent(Block, {
        get sessionID() {
          return props.sessionID;
        }
      })
    });
    return () => {
      release();
      off();
    };
  }
});
