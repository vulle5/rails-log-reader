// Wires every button on /scenarios to fetch() its endpoint — once, or several times at once
// for the Scenarios that are about concurrency (`data-count`). Plain JS, no build step: this
// app has no JS framework anywhere else and a Scenario is not the exception.
document.addEventListener("DOMContentLoaded", () => {
  const output = document.getElementById("scenario-output");

  document.querySelectorAll("[data-scenario]").forEach((button) => {
    button.addEventListener("click", () => {
      const path = button.dataset.scenario;
      const count = Number(button.dataset.count || 1);

      output.textContent = `Running ${path} × ${count}…`;

      const requests = Array.from({ length: count }, () => fetch(path));

      Promise.allSettled(requests).then((results) => {
        const summary = results
          .map((result) => (result.status === "fulfilled" ? result.value.status : "failed"))
          .join(", ");

        output.textContent = `${path} × ${count}: ${summary}`;
      });
    });
  });
});
