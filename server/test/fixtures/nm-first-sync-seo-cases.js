// Minimal observed NM acceptance shapes, not a production report or credentials.
// Text is synthetic. NM021's remote ID is deliberately synthetic: preview did
// not expose it. Nine weight conflicts and 34 derived SEO differences are retained.
module.exports = [
  ['NM111112110021','21.400','21',3850,99021,false],
  ['NM111112110028','27.800','28',5000,2379,false],
  ['NM111112110022','22.000','22',3950,2380,false],
  ['NM111112110024','24.300','24',4350,4223,false],
  ['NM111412110026','26.200','26',5900,4226,false],
  ['NM111112110031','30.600','31',5500,4227,false],
  ['NM111311110021','20.700','21',3700,4234,false],
  ['NM111311110017','17.300','17',3850,4298,true],
  ['NM111311111015','14.700','15',2650,4299,true],
  ['NM111113110040','39.500','40',8800,4301,true],
].map(([sku,localWeight,remoteWeight,price,remoteId,baseSeoEqual])=>({sku,localWeight,remoteWeight,price,remoteId,baseSeoEqual}));
