'use strict';

const express = require('express');
const path = require('path');

const app = express();

// Le frontend est volontairement minimal : une page statique qui appelle
// l'API directement (CORS activé côté api). En L1, les étudiants y ajoutent
// la génération de l'ID de corrélation côté client.
app.use(express.static(path.join(__dirname, 'public')));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`frontend prêt sur le port ${port}`); // TODO(student, L1): idem
});
