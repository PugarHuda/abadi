(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var bar = document.querySelector('.bar i');
  var count = document.querySelector('.count b');
  var prev = document.getElementById('prev');
  var next = document.getElementById('next');
  var hint = document.querySelector('.hint');
  var announce = document.getElementById('announce');
  var i = 0;

  function show(n, push) {
    n = Math.max(0, Math.min(slides.length - 1, n));
    slides[i].classList.remove('on');
    i = n;
    slides[i].classList.add('on');
    slides[i].scrollTop = 0;
    bar.style.transform = 'scaleX(' + ((i + 1) / slides.length) + ')';
    count.textContent = String(i + 1).padStart(2, '0');
    prev.disabled = i === 0;
    next.disabled = i === slides.length - 1;
    // The counter is a sighted affordance. Without this, moving a slide is silent: the
    // whole page is one screen and nothing about it changes that a screen reader reads.
    // Only on a move — announcing the first slide over the page load helps nobody.
    if (push) {
      var head = slides[i].querySelector('h1, h2, .line');
      announce.textContent =
        'Slide ' + (i + 1) + ' of ' + slides.length + (head ? ': ' + head.textContent.trim() : '');
    }
    if (push) history.replaceState(null, '', '#' + (i + 1));
  }

  function go(d) { show(i + d, true); if (hint) hint.classList.add('gone'); }

  document.addEventListener('keydown', function (e) {
    // Space is a button's own activation key. Swallowing it here ran go(1) AND cancelled
    // the button's click, so Space on the focused "previous" button went forward. A
    // control that is focused owns its keys; the deck only handles what is left over.
    var t = e.target;
    if (e.key === ' ' && t && t.closest && t.closest('button, a, input, select, textarea')) return;

    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    else if (e.key === 'Home') { e.preventDefault(); show(0, true); }
    else if (e.key === 'End') { e.preventDefault(); show(slides.length - 1, true); }
  });

  next.addEventListener('click', function () { go(1); });
  prev.addEventListener('click', function () { go(-1); });

  var x0 = null;
  document.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 48) go(dx < 0 ? 1 : -1);
    x0 = null;
  }, { passive: true });

  var start = parseInt((location.hash || '').slice(1), 10);
  show(isNaN(start) ? 0 : start - 1, false);
})();
