// MAIN world: automatically close the corresponding XCALLY customer popup tab when a call ends.
(() => {
  const CLOSE_BUTTON_SELECTOR = [
    'button[aria-label="close"][ng-click*="closeTab"]',
    'button[aria-label="close"][data-ng-click*="closeTab"]',
    'button[ng-click*="closeTab"]',
    'button[data-ng-click*="closeTab"]'
  ].join(', ');
  const CLOSE_ICON_SELECTOR = 'md-icon[md-font-icon="icon-close-circle-outline"], md-icon[md-font-icon*="close"]';
  const PRE_CALL_WINDOW_MS = 60000;
  const DISCONNECT_GRACE_MS = 1500;

  let autoCloseEnabled = true;
  let nextCallId = 1;
  let activeCall = null;
  let sonaAudioActive = false;
  let observer = null;

  const trackedButtons = new Map();
  const unclaimedButtons = new Set();
  const liveMicTracks = new Set();
  const callTracks = new WeakSet();
  const watchedTracks = new WeakSet();
  const watchedPCs = new WeakSet();
  const disconnectTimers = new WeakMap();

  function isXcallyCloseButton(node) {
    if (!node || node.nodeType !== 1 || node.tagName !== 'BUTTON') return false;
    const ngClick = node.getAttribute('ng-click') || node.getAttribute('data-ng-click') || '';
    if (!ngClick.includes('closeTab')) return false;
    const ariaLabel = (node.getAttribute('aria-label') || '').trim().toLowerCase();
    if (ariaLabel && ariaLabel !== 'close') return false;
    return Boolean(node.querySelector?.(CLOSE_ICON_SELECTOR)) || ariaLabel === 'close';
  }

  function getAngularScope(button) {
    try {
      if (typeof window.angular?.element !== 'function') return null;
      const wrapped = window.angular.element(button);
      return wrapped?.scope?.() || wrapped?.isolateScope?.() || null;
    } catch (_error) {
      return null;
    }
  }

  function extractPhoneDigits(value) {
    if (value == null) return null;
    const match = String(value).match(/\+?\d[\d\s()-]{5,}\d/);
    if (!match) return null;
    return match[0].replace(/\D/g, '');
  }

  function findTabContainer(button) {
    const closestMatch = button.closest?.(
      'md-tab-item, [role="tab"], [ng-repeat], [data-ng-repeat], .md-tab, li'
    );
    if (closestMatch) return closestMatch;

    let current = button.parentElement;
    let best = current;
    for (let depth = 0; current && depth < 4; depth++, current = current.parentElement) {
      const tag = current.tagName;
      if (tag === 'BODY' || tag === 'HTML' || tag === 'HEADER' || tag === 'NAV' || tag === 'MAIN') break;
      const buttonsInNode = current.querySelectorAll?.(CLOSE_BUTTON_SELECTOR);
      if (buttonsInNode && buttonsInNode.length > 1) break;
      best = current;
    }
    return best;
  }

  function getContainerLabel(container, button) {
    if (!container || container === button) return '';
    try {
      const clone = container.cloneNode?.(true);
      if (clone?.querySelectorAll) {
        for (const btn of clone.querySelectorAll('button')) btn.remove?.();
        return (clone.textContent || '').trim().replace(/\s+/g, ' ');
      }
    } catch (_error) {
      // Fallback to raw textContent below.
    }
    return (container.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function isLightBackground(bgColor) {
    if (!bgColor || typeof bgColor !== 'string') return false;
    if (bgColor === '#ffffff' || bgColor === '#fafafa' || bgColor === '#f5f5f5') return true;
    const match = bgColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!match) return false;
    const r = Number(match[1]);
    const g = Number(match[2]);
    const b = Number(match[3]);
    const a = match[4] !== undefined ? Number(match[4]) : 1;
    return a > 0.5 && r > 200 && g > 200 && b > 200;
  }

  function isTabContainerActive(button, container, scope, angularTab) {
    if (angularTab?.active === true || angularTab?.selected === true || angularTab?.isActive === true) {
      return true;
    }
    const vm = scope?.vm || scope?.$parent?.vm;
    if (vm && angularTab && (vm.activeTab === angularTab || vm.selectedTab === angularTab || vm.currentTab === angularTab)) {
      return true;
    }
    if (vm && typeof scope?.$index === 'number' &&
        (vm.selectedIndex === scope.$index || vm.activeIndex === scope.$index)) {
      return true;
    }

    let current = button.parentElement || container;
    for (let depth = 0; current && depth < 5; depth++, current = current.parentElement) {
      const tag = current.tagName;
      if (tag === 'BODY' || tag === 'HTML' || tag === 'HEADER' || tag === 'NAV') break;
      const buttonsInNode = current.querySelectorAll?.(CLOSE_BUTTON_SELECTOR);
      if (buttonsInNode && buttonsInNode.length > 1) break;
      if (
        current.classList?.contains?.('md-active') ||
        current.classList?.contains?.('active') ||
        current.classList?.contains?.('selected') ||
        current.classList?.contains?.('current') ||
        current.getAttribute?.('aria-selected') === 'true'
      ) {
        return true;
      }
      if (typeof window.getComputedStyle === 'function') {
        try {
          const bg = window.getComputedStyle(current)?.backgroundColor;
          if (isLightBackground(bg)) return true;
        } catch (_error) {
          // Ignore style lookup errors in non-DOM test environments.
        }
      }
    }
    return false;
  }

  function getTabMetadata(button) {
    const scope = getAngularScope(button);
    const angularTab = scope?.tab || null;
    const container = findTabContainer(button);
    const label = String(
      angularTab?.title ?? angularTab?.label ?? angularTab?.name ?? getContainerLabel(container, button) ?? ''
    ).trim();
    const rawTabId = angularTab?.id ?? angularTab?.uniqueid ?? angularTab?.callId ??
      container?.getAttribute?.('data-tab-id') ?? button.getAttribute?.('data-tab-id') ?? null;
    const tabId = rawTabId != null ? String(rawTabId) : null;
    const phone = extractPhoneDigits(
      angularTab?.phone ?? angularTab?.callerIdNum ?? angularTab?.number ??
      container?.getAttribute?.('data-phone') ?? button.getAttribute?.('data-phone') ?? label
    );
    const isActive = isTabContainerActive(button, container, scope, angularTab);
    return { tabId, label, phone, isActive, angularTab };
  }

  function registerButton(button, { markPreExisting = false, bindToActiveCall = true } = {}) {
    if (!isXcallyCloseButton(button)) return null;
    const existing = trackedButtons.get(button);
    if (existing) return existing;

    const now = Date.now();
    const meta = getTabMetadata(button);
    const record = {
      button,
      addedAt: now,
      preExisting: Boolean(markPreExisting),
      callId: null,
      closed: false,
      meta
    };
    trackedButtons.set(button, record);

    button.addEventListener?.('click', () => {
      record.closed = true;
      trackedButtons.delete(button);
      unclaimedButtons.delete(button);
      if (activeCall) {
        activeCall.directButtons.delete(button);
        if (activeCall.ringingButton === button) activeCall.ringingButton = null;
      }
    }, { once: true });

    if (bindToActiveCall && activeCall && !activeCall.ended) {
      record.callId = activeCall.id;
      record.preExisting = false;
      activeCall.directButtons.add(button);
      console.info('[Sona XCALLY] Popup tab detected and linked to active call:', {
        callId: activeCall.id,
        label: meta.label || 'unknown',
        phone: meta.phone,
        isActive: meta.isActive
      });
    } else if (!markPreExisting) {
      unclaimedButtons.add(button);
      console.info('[Sona XCALLY] Popup tab detected (awaiting call connection):', {
        label: meta.label || 'unknown',
        phone: meta.phone,
        isActive: meta.isActive
      });
    }
    return record;
  }

  function pruneDisconnectedButtons() {
    for (const [button, record] of trackedButtons) {
      if (button.isConnected === false || record.closed) {
        trackedButtons.delete(button);
        unclaimedButtons.delete(button);
      }
    }
  }

  function flushObserverMutations() {
    if (!observer || typeof observer.takeRecords !== 'function') return;
    const pending = observer.takeRecords();
    if (pending?.length) handleMutations(pending);
  }

  function findCloseButtons() {
    flushObserverMutations();
    pruneDisconnectedButtons();
    const list = [];
    const seen = new Set();
    const queried = document.querySelectorAll?.(CLOSE_BUTTON_SELECTOR) || [];
    for (const node of queried) {
      if (isXcallyCloseButton(node) && node.isConnected !== false) {
        seen.add(node);
        list.push(node);
      }
    }
    for (const [button, record] of trackedButtons) {
      if (!seen.has(button) && !record.closed && button.isConnected !== false && isXcallyCloseButton(button)) {
        list.push(button);
      }
    }
    return list;
  }

  function scanExistingButtons(options = {}) {
    const buttons = findCloseButtons();
    for (const button of buttons) {
      if (!trackedButtons.has(button)) registerButton(button, options);
    }
    return buttons;
  }

  function handleMutations(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) {
        if (!node || node.nodeType !== 1) continue;
        if (isXcallyCloseButton(node)) registerButton(node);
        const nested = node.querySelectorAll?.(CLOSE_BUTTON_SELECTOR) || [];
        for (const child of nested) registerButton(child);
      }
      if (mutation.removedNodes?.length) pruneDisconnectedButtons();
    }
  }

  function startObserver() {
    if (observer || typeof MutationObserver === 'undefined') return;
    const root = document.documentElement || document.body;
    if (!root) {
      window.addEventListener?.('DOMContentLoaded', startObserver, { once: true });
      return;
    }
    scanExistingButtons({ markPreExisting: true, bindToActiveCall: false });
    observer = new MutationObserver(handleMutations);
    observer.observe(root, { childList: true, subtree: true });
  }

  function notifyTopFrame(type, detail) {
    try {
      if (window.top && window.top !== window) {
        window.top.postMessage({ source: 'sona-xcally', type, detail }, '*');
      }
    } catch (_error) {
      // Ignore cross-origin frame restrictions.
    }
  }

  function startCall(reason, metadata = {}) {
    flushObserverMutations();
    if (activeCall && !activeCall.ended) {
      if (metadata.phone && !activeCall.phone) activeCall.phone = extractPhoneDigits(metadata.phone);
      if (metadata.tabId && !activeCall.tabId) activeCall.tabId = String(metadata.tabId);
      if (metadata.label && !activeCall.label) activeCall.label = String(metadata.label);
      return activeCall;
    }

    // Discover any buttons added before the call started if MutationObserver did not report them yet.
    scanExistingButtons({ markPreExisting: false, bindToActiveCall: false });

    const now = Date.now();
    const call = {
      id: metadata.callId || nextCallId++,
      startedAt: now,
      reason,
      phone: extractPhoneDigits(metadata.phone || metadata.label),
      tabId: metadata.tabId != null ? String(metadata.tabId) : null,
      label: metadata.label != null ? String(metadata.label) : null,
      pcs: new Set(),
      senders: new Set(),
      tracks: new Set(),
      directButtons: new Set(),
      ringingButton: null,
      ended: false
    };

    for (const track of liveMicTracks) {
      if (track.readyState === 'live') call.tracks.add(track);
      else liveMicTracks.delete(track);
    }

    const recentUnclaimed = [...unclaimedButtons].filter(btn => {
      if (btn.isConnected === false) return false;
      const record = trackedButtons.get(btn);
      return record && !record.preExisting && !record.closed && now - record.addedAt <= PRE_CALL_WINDOW_MS;
    });
    if (recentUnclaimed.length === 1) {
      const candidate = recentUnclaimed[0];
      const record = trackedButtons.get(candidate);
      call.ringingButton = candidate;
      if (record) record.callId = call.id;
    } else if (recentUnclaimed.length > 1) {
      const activeCandidates = recentUnclaimed.filter(btn => getTabMetadata(btn).isActive);
      if (activeCandidates.length === 1) {
        const candidate = activeCandidates[0];
        const record = trackedButtons.get(candidate);
        call.ringingButton = candidate;
        if (record) record.callId = call.id;
      }
    }
    for (const btn of unclaimedButtons) {
      const record = trackedButtons.get(btn);
      if (record && record.callId !== call.id) record.preExisting = true;
    }
    unclaimedButtons.clear();

    activeCall = call;
    console.info('[Sona XCALLY] Call started:', {
      callId: call.id,
      reason,
      hasRingingPopup: Boolean(call.ringingButton)
    });
    notifyTopFrame('call-started', {
      callId: call.id,
      reason,
      phone: call.phone,
      tabId: call.tabId,
      label: call.label
    });
    return call;
  }

  function matchesCriteria(button, criteria) {
    if (!criteria) return false;
    if (criteria.button && criteria.button === button) return true;
    const meta = getTabMetadata(button);
    if (criteria.tabId != null && meta.tabId != null && String(criteria.tabId) === meta.tabId) {
      return true;
    }
    const targetPhone = extractPhoneDigits(criteria.phone || criteria.label);
    if (targetPhone && meta.phone && (meta.phone === targetPhone || meta.phone.endsWith(targetPhone) || targetPhone.endsWith(meta.phone))) {
      return true;
    }
    if (criteria.label && meta.label && meta.label.toLowerCase().includes(String(criteria.label).trim().toLowerCase())) {
      return true;
    }
    return false;
  }

  function invokeAngularCloseFallback(button) {
    if (!button || button.isConnected === false) return;
    try {
      const scope = getAngularScope(button);
      if (!scope) return;
      const vm = scope.vm || scope.$parent?.vm;
      const tab = scope.tab;
      if (typeof vm?.closeTab === 'function' && tab) {
        console.info('[Sona XCALLY] Invoking AngularJS vm.closeTab(tab) fallback');
        if (typeof scope.$applyAsync === 'function') {
          scope.$applyAsync(() => vm.closeTab(tab));
        } else {
          vm.closeTab(tab);
          scope.$root?.$digest?.();
        }
        return;
      }
      if (typeof scope.$eval === 'function') {
        console.info('[Sona XCALLY] Evaluating AngularJS closeTab(tab) expression fallback');
        const runEval = () => scope.$eval('vm.closeTab(tab)', {
          $event: { stopPropagation() {}, preventDefault() {} }
        });
        if (typeof scope.$applyAsync === 'function') scope.$applyAsync(runEval);
        else {
          runEval();
          scope.$root?.$digest?.();
        }
      }
    } catch (_error) {
      // Ignore AngularJS fallback errors if DOM click already handled closure.
    }
  }

  function clickCloseButton(button, reason, callId = null) {
    if (!button || button.isConnected === false) return false;
    const record = trackedButtons.get(button);
    if (record?.closed) return false;
    const meta = getTabMetadata(button);
    if (record) record.closed = true;
    trackedButtons.delete(button);
    unclaimedButtons.delete(button);
    console.info('[Sona XCALLY] Clicking close button for customer popup:', {
      callId,
      reason,
      label: meta.label || 'unknown',
      phone: meta.phone,
      tabId: meta.tabId,
      isActive: meta.isActive
    });
    button.click();
    if (button.isConnected !== false) {
      setTimeout(() => invokeAngularCloseFallback(button), 50);
    }
    return true;
  }

  function closePopupForCall(call, reason, criteria = {}) {
    if (!autoCloseEnabled) {
      console.info('[Sona XCALLY] Call ended, but Auto-close call popup is disabled:', {
        callId: call?.id ?? criteria.callId ?? null,
        reason
      });
      return 0;
    }

    // Catch any buttons inserted synchronously during the call before MutationObserver flushed.
    const allButtons = scanExistingButtons({
      markPreExisting: !call,
      bindToActiveCall: Boolean(call)
    });

    if (!allButtons.length) {
      console.info('[Sona XCALLY] Call ended, no open XCALLY customer popup found:', {
        callId: call?.id ?? criteria.callId ?? null,
        reason
      });
      return 0;
    }

    const mergedCriteria = {
      button: criteria.button,
      tabId: criteria.tabId ?? call?.tabId ?? null,
      phone: criteria.phone ?? call?.phone ?? null,
      label: criteria.label ?? call?.label ?? null
    };

    // 1. Explicit target match (by button, tabId, phone number, or label).
    if (mergedCriteria.button || mergedCriteria.tabId || mergedCriteria.phone || mergedCriteria.label) {
      const explicitMatches = allButtons.filter(btn => matchesCriteria(btn, mergedCriteria));
      if (explicitMatches.length) {
        let closedCount = 0;
        for (const btn of explicitMatches) {
          if (clickCloseButton(btn, `${reason} (matched identifier)`, call?.id ?? null)) closedCount++;
        }
        return closedCount;
      }
    }

    // 2. Popup tab(s) opened while the call was active.
    if (call) {
      const direct = [...call.directButtons].filter(btn => btn.isConnected !== false && allButtons.includes(btn));
      if (direct.length) {
        let closedCount = 0;
        for (const btn of direct) {
          if (clickCloseButton(btn, `${reason} (opened during call)`, call.id)) closedCount++;
        }
        return closedCount;
      }

      // 3. Popup tab opened during the ringing/pre-call window right before the call connected.
      if (call.ringingButton && call.ringingButton.isConnected !== false && allButtons.includes(call.ringingButton)) {
        return clickCloseButton(call.ringingButton, `${reason} (opened on ringing)`, call.id) ? 1 : 0;
      }
    }

    // 4. Active/selected popup tab fallback (e.g. when the agent is viewing the active customer popup during the call).
    const activeButtons = allButtons.filter(btn => getTabMetadata(btn).isActive);
    if (activeButtons.length === 1) {
      return clickCloseButton(activeButtons[0], `${reason} (active customer tab)`, call?.id ?? null) ? 1 : 0;
    }

    // 5. Single open popup tab fallback (when only 1 customer popup tab exists in the bar).
    if (allButtons.length === 1) {
      return clickCloseButton(allButtons[0], `${reason} (single open popup tab)`, call?.id ?? null) ? 1 : 0;
    }

    // 6. Multiple non-active tabs exist with no call correlation: do not close unrelated tabs.
    console.warn('[Sona XCALLY] Skipping popup auto-close: no popup tab correlated with the ended call:', {
      callId: call?.id ?? null,
      reason,
      openPopupCount: allButtons.length
    });
    return 0;
  }

  function endCall(call, reason, criteria = {}) {
    if (!call || call.ended) return 0;
    call.ended = true;
    sonaAudioActive = false;
    for (const pc of call.pcs) {
      const timer = disconnectTimers.get(pc);
      if (timer) {
        clearTimeout(timer);
        disconnectTimers.delete(pc);
      }
    }
    call.pcs.clear();
    call.senders.clear();
    call.tracks.clear();
    if (activeCall === call) activeCall = null;

    console.info('[Sona XCALLY] Call ended:', { callId: call.id, reason });
    notifyTopFrame('call-ended', {
      callId: call.id,
      reason,
      phone: call.phone,
      tabId: call.tabId,
      label: call.label
    });
    return closePopupForCall(call, reason, criteria);
  }

  function checkPeerConnectionState(pc, call, eventName) {
    const connState = pc.connectionState;
    const iceState = pc.iceConnectionState;
    const sigState = pc.signalingState;
    const targetCall = call || activeCall;

    if (
      connState === 'closed' || connState === 'failed' ||
      iceState === 'closed' || iceState === 'failed' ||
      sigState === 'closed'
    ) {
      if (!targetCall || targetCall.ended || !targetCall.pcs.has(pc)) return;
      const existingTimer = disconnectTimers.get(pc);
      if (existingTimer) {
        clearTimeout(existingTimer);
        disconnectTimers.delete(pc);
      }
      targetCall.pcs.delete(pc);
      if (targetCall.pcs.size === 0) {
        endCall(targetCall, `${eventName}:${connState || iceState || sigState}`);
      }
      return;
    }

    if (connState === 'disconnected' || iceState === 'disconnected') {
      if (!targetCall || targetCall.ended || !targetCall.pcs.has(pc)) return;
      if (targetCall.tracks.size > 0 && [...targetCall.tracks].every(track => track.readyState === 'ended')) {
        targetCall.pcs.delete(pc);
        if (targetCall.pcs.size === 0) endCall(targetCall, `${eventName}:disconnected`);
        return;
      }
      if (!disconnectTimers.has(pc)) {
        const timer = setTimeout(() => {
          disconnectTimers.delete(pc);
          if (targetCall.ended || !targetCall.pcs.has(pc)) return;
          if (
            pc.connectionState === 'disconnected' || pc.connectionState === 'closed' || pc.connectionState === 'failed' ||
            pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed' || pc.iceConnectionState === 'failed'
          ) {
            targetCall.pcs.delete(pc);
            if (targetCall.pcs.size === 0) endCall(targetCall, `${eventName}:disconnected-timeout`);
          }
        }, DISCONNECT_GRACE_MS);
        disconnectTimers.set(pc, timer);
      }
      return;
    }

    if (connState === 'connecting' || connState === 'connected' ||
        iceState === 'checking' || iceState === 'connected' || iceState === 'completed') {
      const active = targetCall || startCall(`${eventName}:${connState || iceState}`);
      active.pcs.add(pc);
      const existingTimer = disconnectTimers.get(pc);
      if (existingTimer && (connState === 'connected' || iceState === 'connected' || iceState === 'completed')) {
        clearTimeout(existingTimer);
        disconnectTimers.delete(pc);
      }
    }
  }

  function registerMicTrack(track) {
    if (!track || track.kind !== 'audio' || track.readyState === 'ended') return;
    callTracks.add(track);
    liveMicTracks.add(track);
    if (activeCall && !activeCall.ended) {
      activeCall.tracks.add(track);
    }
    if (!watchedTracks.has(track)) {
      watchedTracks.add(track);
      track.addEventListener?.('ended', () => {
        handleTrackEnded(track, 'track.ended');
      }, { once: true });
    }
  }

  function attachCallTrack(track, reason) {
    if (!track || track.kind !== 'audio' || track.readyState === 'ended') return;
    const call = startCall(reason);
    registerMicTrack(track);
    call.tracks.add(track);
  }

  function handleTrackEnded(track, reason) {
    liveMicTracks.delete(track);
    if (!callTracks.has(track)) return;
    const call = activeCall;
    if (!call || call.ended || !call.tracks.has(track)) return;
    call.tracks.delete(track);
    if (call.tracks.size === 0) {
      endCall(call, reason);
    }
  }

  function observePeerConnection(pc) {
    if (!pc || watchedPCs.has(pc)) return;
    watchedPCs.add(pc);
    pc.addEventListener?.('connectionstatechange', () => {
      checkPeerConnectionState(pc, activeCall, 'connectionstatechange');
    });
    pc.addEventListener?.('iceconnectionstatechange', () => {
      checkPeerConnectionState(pc, activeCall, 'iceconnectionstatechange');
    });
    pc.addEventListener?.('signalingstatechange', () => {
      checkPeerConnectionState(pc, activeCall, 'signalingstatechange');
    });
  }

  function registerPeerConnection(pc, sender, track, reason) {
    if (!pc) return;
    const call = startCall(reason);
    call.pcs.add(pc);
    if (sender) call.senders.add(sender);
    if (track && track.kind === 'audio' && track.readyState !== 'ended') {
      attachCallTrack(track, reason);
    }
    observePeerConnection(pc);
  }

  // Hook WebRTC and MediaStream lifecycle in the MAIN world without altering existing behavior.
  for (const pcKey of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    const OriginalPC = window[pcKey];
    if (typeof OriginalPC !== 'function') continue;
    function WrappedPeerConnection(...args) {
      const pc = new OriginalPC(...args);
      observePeerConnection(pc);
      return pc;
    }
    WrappedPeerConnection.prototype = OriginalPC.prototype;
    Object.setPrototypeOf(WrappedPeerConnection, OriginalPC);
    window[pcKey] = WrappedPeerConnection;
  }

  const NativePC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (NativePC?.prototype) {
    const proto = NativePC.prototype;
    if (typeof proto.addTrack === 'function') {
      const prevAddTrack = proto.addTrack;
      proto.addTrack = function (track, ...streams) {
        const sender = prevAddTrack.call(this, track, ...streams);
        if (track?.kind === 'audio') {
          registerPeerConnection(this, sender, track, 'pc.addTrack');
        }
        return sender;
      };
    }
    if (typeof proto.addTransceiver === 'function') {
      const prevAddTransceiver = proto.addTransceiver;
      proto.addTransceiver = function (trackOrKind, init) {
        const transceiver = prevAddTransceiver.call(this, trackOrKind, init);
        if (trackOrKind === 'audio' || trackOrKind?.kind === 'audio') {
          const track = typeof trackOrKind === 'object' ? trackOrKind : transceiver?.sender?.track;
          registerPeerConnection(this, transceiver?.sender, track, 'pc.addTransceiver');
        }
        return transceiver;
      };
    }
    if (typeof proto.addStream === 'function') {
      const prevAddStream = proto.addStream;
      proto.addStream = function (stream, ...rest) {
        const result = prevAddStream.call(this, stream, ...rest);
        const audioTracks = stream?.getAudioTracks?.() || [];
        if (audioTracks.length) {
          for (const track of audioTracks) {
            registerPeerConnection(this, null, track, 'pc.addStream');
          }
        }
        return result;
      };
    }
    if (typeof proto.removeTrack === 'function') {
      const prevRemoveTrack = proto.removeTrack;
      proto.removeTrack = function (sender) {
        const result = prevRemoveTrack.call(this, sender);
        if (activeCall && !activeCall.ended && activeCall.pcs.has(this)) {
          activeCall.senders.delete(sender);
          if (activeCall.senders.size === 0 && activeCall.pcs.size <= 1) {
            endCall(activeCall, 'pc.removeTrack');
          }
        }
        return result;
      };
    }
    if (typeof proto.close === 'function') {
      const prevClose = proto.close;
      proto.close = function () {
        const result = prevClose.call(this);
        if (activeCall && !activeCall.ended && activeCall.pcs.has(this)) {
          activeCall.pcs.delete(this);
          if (activeCall.pcs.size === 0) {
            endCall(activeCall, 'pc.close');
          }
        }
        return result;
      };
    }
  }

  if (typeof MediaStreamTrack !== 'undefined' && MediaStreamTrack.prototype) {
    const prevStop = MediaStreamTrack.prototype.stop;
    if (typeof prevStop === 'function') {
      MediaStreamTrack.prototype.stop = function () {
        const wasCallTrack = callTracks.has(this);
        const wasSenderTrack = Boolean(
          activeCall && !activeCall.ended &&
          [...activeCall.senders].some(sender => sender?.track === this)
        );
        const result = prevStop.call(this);
        if (wasCallTrack) {
          handleTrackEnded(this, 'track.stop');
        } else if (wasSenderTrack) {
          endCall(activeCall, 'sender.track.stop');
        }
        return result;
      };
    }
    const prevClone = MediaStreamTrack.prototype.clone;
    if (typeof prevClone === 'function') {
      MediaStreamTrack.prototype.clone = function () {
        const copy = prevClone.call(this);
        if (callTracks.has(this) && copy?.kind === 'audio') {
          registerMicTrack(copy);
        }
        return copy;
      };
    }
  }

  if (navigator.mediaDevices?.getUserMedia) {
    const prevGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const stream = await prevGetUserMedia(constraints);
      if (constraints?.audio && stream?.getAudioTracks) {
        for (const track of stream.getAudioTracks()) {
          registerMicTrack(track);
        }
      }
      return stream;
    };
  }

  // Also observe Sona's own audio session state transitions from noise-suppression.js.
  window.addEventListener('sona-audio-state', event => {
    const phase = event?.detail?.phase;
    if (phase === 'starting' || phase === 'filtering' || phase === 'fallback') {
      sonaAudioActive = true;
      startCall(`sona-audio-state:${phase}`);
    } else if ((phase === 'ready' || phase === 'closed') && sonaAudioActive) {
      sonaAudioActive = false;
      if (activeCall && !activeCall.ended) {
        endCall(activeCall, `sona-audio-state:${phase}`);
      }
    } else if (phase === 'off') {
      sonaAudioActive = false;
    }
  });

  // Listen for extension settings and explicit call/popup events.
  function applyConfig(detail) {
    if (!detail || typeof detail !== 'object') return;
    if (typeof detail.autoClosePopup === 'boolean') {
      autoCloseEnabled = detail.autoClosePopup;
      console.info('[Sona XCALLY] Auto-close call popup setting updated:', {
        enabled: autoCloseEnabled
      });
    }
  }

  window.addEventListener('sona-audio-config', event => applyConfig(event?.detail));
  window.addEventListener('sona-xcally-config', event => applyConfig(event?.detail));

  window.addEventListener('sona-call-started', event => {
    const detail = event?.detail || {};
    startCall(detail.reason || 'sona-call-started', detail);
  });

  window.addEventListener('sona-call-ended', event => {
    const detail = event?.detail || {};
    if (activeCall && !activeCall.ended) {
      endCall(activeCall, detail.reason || 'sona-call-ended', detail);
    } else {
      closePopupForCall(null, detail.reason || 'sona-call-ended', detail);
    }
  });

  window.addEventListener('sona-close-xcally-popup', event => {
    const detail = event?.detail || {};
    closePopupForCall(activeCall, detail.reason || 'sona-close-xcally-popup', detail);
  });

  window.addEventListener('message', event => {
    if (event.source === window) return;
    const data = event.data;
    if (!data || data.source !== 'sona-xcally') return;
    if (data.type === 'call-started') {
      startCall(data.detail?.reason || 'subframe-call-started', data.detail || {});
    } else if (data.type === 'call-ended') {
      if (activeCall && !activeCall.ended) {
        endCall(activeCall, data.detail?.reason || 'subframe-call-ended', data.detail || {});
      } else {
        closePopupForCall(null, data.detail?.reason || 'subframe-call-ended', data.detail || {});
      }
    }
  });

  window.SonaXcallyPopup = Object.freeze({
    isEnabled: () => autoCloseEnabled,
    findCloseButtons,
    getTabMetadata,
    closePopup: (criteria = {}) => closePopupForCall(activeCall, 'manual-api', criteria)
  });

  startObserver();
  window.dispatchEvent(new CustomEvent('sona-audio-config-request'));
})();
