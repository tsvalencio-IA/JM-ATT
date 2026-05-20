/*
Teste rápido no Console do navegador após publicar a v13.
Abra jm.html?v=jm-financeiro-frota-kpi-v13, faça login e cole este script.
*/
(function () {
  const ids = [
    'financeForm', 'financeTable', 'expenseApproval', 'financeKpiTables',
    'vehicleForm', 'maintenanceForm', 'maintenanceTable', 'fleetKpiBox',
    'callsTable', 'teamTable', 'fleetMap'
  ];
  const missing = ids.filter((id) => !document.getElementById(id));
  console.log('JM v13 - elementos ausentes:', missing);
  console.log('JM.app disponível:', !!(window.JM && window.JM.app));
  console.log('Estado atual:', window.JM && window.JM.app && window.JM.app.state);
  if (!missing.length && window.JM && window.JM.app) {
    alert('JM v13 carregou os módulos principais de financeiro, frota, chamados e equipe. Agora teste salvar/editar/excluir com usuário gestor.');
  }
}());
