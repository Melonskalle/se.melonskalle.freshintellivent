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
3. För styrning behövs autentiseringskoden: tryck en gång på av/på-symbolen på panelen och håll
   sedan ljus/luftkvalitet-symbolen i 8 sekunder tills den blinkar (parkopplingsläge)
   → "Hämta kod från fläkten". Det kan ta upp till en minut.
   Har du koden från Home Assistant kan du skriva in den direkt (8 hextecken).
4. Utan kod läggs fläkten till som bara läsande. Koden kan läggas till senare via
   enhetens inställningar eller *Reparera*.

## Vad finns
- **Sensorer:** temperatur, luftfuktighet, fläktvarvtal, aktuellt läge, boost kvar (min)
- **Reglage (som i Fresh-appen):** Boost, Paus, Konstant fart (på/av + varvtal),
  Fuktsensor, Ljussensor och Luktsensor (av/låg/mellan/hög), Vädringsfunktion (av/30/60/90/120 min)
- **Inställningar:** boost (varvtal, längd), paustid, varvtal för fukt-/luktsensor, ljussensor/timer
  och vädring, timer (gångtid, fördröjd start)
- **Flöden**
  - När: läget ändrades, boost startade, boost slutade
  - Och: boost körs, läget är …
  - Då: starta/stoppa boost, konstant fart på/av/varvtal, pausa/avsluta paus,
    ställ in fukt-, ljus- och luktsensor, vädring och timer

## Bra att veta
- Fläkten tar bara en Bluetooth-anslutning åt gången. Appen ansluter, läser/skriver och
  kopplar ner direkt (som HA-integrationen). Om Fresh-appen i mobilen är ansluten
  misslyckas Homey tills den släpper.
- Räckvidden avgör: Homey måste nå badrummet via Bluetooth.
- Standardintervall 120 s. Under boost görs en extra avläsning direkt när boosten är slut.
- Känslighetsnivåerna skrivs som de råa värden fläkten själv rapporterar (VOC har omvänd
  skala: 1 = hög, 3 = låg, enligt pyfreshintellivent).

## Tack till
- [angoyd/freshintelliventHacs](https://github.com/angoyd/freshintelliventHacs) och pyfreshintellivent – protokollet
- [JYxfeldt/Homey-Intellivent](https://github.com/JYxfeldt/Homey-Intellivent) – metoden att upprepa tjänsteuppslaget på samma anslutning (Homey ger ~10 s, fläkten behöver ~16 s)
- [SavyTechLabs/Fresh-Intellivent](https://github.com/SavyTechLabs/Fresh-Intellivent) (MIT) – fläktens GATT-service-UUID:er
  och insikten att fullständig tjänsteuppslagning är för långsam (fläkten kopplar ner efter ~5 s)
