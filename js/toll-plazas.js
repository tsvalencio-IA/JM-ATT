(function () {
  "use strict";

  /*
   * Local toll plaza table.
   *
   * Keep demo rows inactive. To use in production, replace/add rows with
   * checked source data, tariff date, coordinates and active: true.
   */
  window.JM_TOLL_PLAZAS = [
    {
      id: "demo-sp-local-001",
      name: "EXEMPLO INATIVO - Praca de pedagio local",
      road: "RODOVIA-DEMO",
      km: "0",
      lat: -20.8113,
      lng: -49.3758,
      direction: "demo",
      tariffs: {
        leve: 0,
        pesado: 0
      },
      active: false,
      demo: true,
      observation: "Exemplo inativo. Substitua por dados oficiais antes de ativar.",
      source: "demo_local_file",
      sourceUpdatedAt: "2026-06-01"
    }
  ];
}());
