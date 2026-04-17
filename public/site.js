(function () {
  const root = document.documentElement;

  function updatePointer(positionX, positionY) {
    const x = Math.max(0, Math.min(100, (positionX / window.innerWidth) * 100));
    const y = Math.max(0, Math.min(100, (positionY / window.innerHeight) * 100));
    root.style.setProperty("--pointer-x", x.toFixed(2) + "%");
    root.style.setProperty("--pointer-y", y.toFixed(2) + "%");
  }

  updatePointer(window.innerWidth * 0.5, window.innerHeight * 0.4);

  window.addEventListener(
    "pointermove",
    (event) => {
      updatePointer(event.clientX, event.clientY);
    },
    { passive: true }
  );

  const interactiveCards = Array.from(document.querySelectorAll("[data-tilt]"));
  interactiveCards.forEach((card) => {
    let rafToken = 0;

    card.addEventListener("pointermove", (event) => {
      const rect = card.getBoundingClientRect();
      const relativeX = (event.clientX - rect.left) / Math.max(rect.width, 1);
      const relativeY = (event.clientY - rect.top) / Math.max(rect.height, 1);

      if (rafToken) {
        cancelAnimationFrame(rafToken);
      }

      rafToken = requestAnimationFrame(() => {
        const rotateY = (relativeX - 0.5) * 6;
        const rotateX = (0.5 - relativeY) * 6;
        card.style.setProperty("--tilt-x", rotateX.toFixed(2) + "deg");
        card.style.setProperty("--tilt-y", rotateY.toFixed(2) + "deg");
        card.classList.add("is-tilting");
      });
    });

    card.addEventListener("pointerleave", () => {
      card.style.setProperty("--tilt-x", "0deg");
      card.style.setProperty("--tilt-y", "0deg");
      card.classList.remove("is-tilting");
    });
  });

  const pageKey = String(document.body.dataset.page || "").trim();
  document.querySelectorAll(".topnav a[data-nav]").forEach((link) => {
    if (link.dataset.nav === pageKey) {
      link.classList.add("is-active");
    }
  });

  const revealNodes = Array.from(document.querySelectorAll(".reveal"));
  if (!("IntersectionObserver" in window)) {
    revealNodes.forEach((node) => node.classList.add("visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      });
    },
    {
      threshold: 0.2,
      rootMargin: "0px 0px -40px"
    }
  );

  revealNodes.forEach((node) => observer.observe(node));
})();