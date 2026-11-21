# Fresh Intellivent för Homey

Homey-app (SDK 3) för Fresh Intellivent Sky/ICE-badrumsfläktar via Bluetooth LE.
Portad från [angoyd/freshintelliventHacs](https://github.com/angoyd/freshintelliventHacs) och
[pyfreshintellivent](https://pypi.org/project/pyfreshintellivent/) 0.3.4.

## Installera
```bash
npm install
homey login
homey app install     # eller: homey app run (för att se loggen live)
```

## Lägga till fläkten
1. Lägg till enhet → Fresh Intellivent → Intellivent Sky / ICE. Homey söker via Bluetooth.
2. Välj fläkten.
3. För styrning behövs autentiseringskoden: tryck på fläktens strömknapp och håll sedan
   Bluetooth/WiFi-knappen i 8 sekunder (parkopplingsläge) → "Hämta kod från fläkten".
   Har du koden från Home Assistant kan du skriva in den direkt (8 hextecken).
4. Utan kod läggs fläkten till som bara läsande. Koden kan läggas till senare via
   enhetens inställningar eller *Reparera*.

## Vad finns
- **Sensorer:** temperatur, luftfuktighet, fläkthastighet (varv/min), aktuellt läge, boost kvar (min)
- **Knappar:** Boost, Konstant hastighet
- **Inställningar** (speglas från fläkten): boost, konstant hastighet, fukt, ljus/VOC, vädring, ljustimer
- **Flöden**
  - När: läget ändrades, boost startade, boost slutade
  - Och: boost körs, läget är …
  - Då: starta boost (varv, minuter), stoppa boost, konstant hastighet på/av, pausa X min,
    avsluta paus, ställ in fuktkänslighet

## Bra att veta
- Fläkten tar bara en Bluetooth-anslutning åt gången. Appen ansluter, läser/skriver och
  kopplar ner direkt (som HA-integrationen). Om Fresh-appen i mobilen är ansluten
  misslyckas Homey tills den släpper.
- Räckvidden avgör: Homey måste nå badrummet via Bluetooth.
- Standardintervall 120 s. Under boost görs en extra avläsning direkt när boosten är slut.
- Känslighetsnivåerna skrivs som de råa värden fläkten själv rapporterar (VOC har omvänd
  skala: 1 = hög, 3 = låg, enligt pyfreshintellivent).
