# Extension hosting stays in AgentSession

`AgentSession` hosts the extension runtime itself: about 430 lines of wiring (nine `_extension*` fields, `_emitExtensionEvent`'s per-event translation, `_bindExtensionCore`'s three object literals of callbacks, `_buildRuntime`, and `reload`'s rebind order). An architecture review on 2026-10-04 proposed an `ExtensionHost` module that owns the runner lifecycle behind a narrow session port. We decided not to do it.

It fails the deletion test. The code is binding, not logic: each callback forwards to a session method, and the event translation copies fields. Moving it behind a port would move the same lines and add the port, without hiding a decision a caller has to make today. It is also cold: `git log` shows no change to `_bindExtensionCore`, `_emitExtensionEvent` or `_buildRuntime` since the first commit, while the review's other candidates had ten or more commits since August. Deepening pays off by making future changes cheaper, and none are arriving here.

Revisit when extension binding starts changing (for example, a new kind of extension context or a change to reload order), or when a second host needs the same lifecycle, such as the server running extensions outside an AgentSession. That second host would make the port a real seam with two adapters.
