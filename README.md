# IBKR Portfolio Viewer

Lokální přehled IBKR Flex reportů, srovnání výkonnosti s benchmarkem a model majetku/FIRE.

## Spuštění a kontrola

Vyžaduje Node.js 24 a pnpm 9.12.3. Před spuštěním aktivujte Node.js 24 ve svém správci verzí (s nvm stačí `nvm install` a `nvm use`; projekt obsahuje `.nvmrc`). Vercel vybírá podporovanou řadu Node.js podle `engines.node` v `package.json`. Nastavení `use-node-version` do projektového `.npmrc` nepatří, protože ho Vercel odmítá.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Aplikace běží na http://localhost:3000. Flex Token a Query ID se zadávají v aplikaci; uložené účty jsou v localStorage prohlížeče. Používejte ji pouze na důvěryhodném zařízení. Serverová cache reportů je v ignorovaném `data/` a obsahuje finanční údaje.

## Data a význam čísel

- Hlavní expozice podle vázaného kapitálu = hodnota držených akcií/ETF/krypta + závazek vypsaných PUT po párovém zajištění, děleno NAV. Covered CALL nezapočítává držené akcie podruhé. Nakoupené CALL a ochranné PUT jsou uvedené samostatně mimo tento ukazatel; jejich samostatná částka je aktuální tržní hodnota. Kategorie Akcie/Komodity/Krypto lze upravit po titulech a uloží se v prohlížeči.
- Portfolio používá skutečnou NAV, hotovost, podepsanou hodnotu pozic a ostatní položky NAV. Short opce jsou závazky. Teoretický závazek při přiřazení PUT není IBKR margin ani disponibilní hotovost.
- Flex je denní report, nikoli živý stav účtu. Datum ocenění je součástí zobrazení.
- Pro Flex zapněte Account Information, Net Asset Value (NAV) in Base, Open Positions (SUMMARY), Cash Report, Statement of Funds, Trades a Conversion Rates. Použijte datum YYYYMMDD a pro historii Last 365 Calendar Days.
- Denní výkonnost očišťuje NAV o doložené externí pohyby. Při chybějící intradenní valuaci používá deklarovanou denní konvenci; nejde o ověření shody s oficiálním IBKR TWR. Chybějící datum NAV se přiřadí k nejbližšímu následujícímu snapshotu, nikoli podle velikosti tržního výnosu.
- Hodnoty různých měn se nesčítají bez přepočtu. Chybějící FX ani neoceněná pozice nejsou nula. Duplicity účtů a neslučitelné reporty se odmítají.
- Daňová část je scénář z brokerových P/L, ne české daňové přiznání. Přepočet historických nákladů, loty před začátkem exportu, další příjmy a nárok na zahraniční zápočet mohou vyžadovat další doklady. Omezení se zobrazují u výpočtu.
- Záložka Výkonnost vs. index je osobní roční přehled v CZK bez daňových přepínačů: uzavřít IBKR pozice a dlouhodobě držet akumulační CSPX, se stejnými vklady a výběry. Hlavní výsledek ukazuje čistý rozdíl v korunách po daních i dopadu na paušální režim; metodika a TWR jsou rozbalovací.
- Profil odpovídá potvrzeným údajům: příjem OSVČ 1,2 mil. Kč, 60% výdajový paušál, zanedbatelné skutečné výdaje, hlavní činnost celý rok, první pásmo paušální daně a základní sleva. Editovat lze pouze roční příjem v rozsahu tohoto profilu; staré scénářové preference se nepřebírají.
- Za každý rok a strategii se automaticky použije výhodnější dostupný způsob zdanění zahraničních dividend (společný progresivní / samostatný 15% základ). Zahraniční zápočet dividend je omezen skutečnou srážkou a 15 % příjmu, úrokové srážky zůstávají bez automatického zápočtu. Neověřená refundace se nepřičítá. Je to modelová optimalizace podle dostupných údajů, nikoli záruka nejnižší možné skutečné daně.
- Souhrnná historie mimo IBKR používá dnešní množství a historické ceny; ruční položky drží konstantní hodnotu. Nepředstavuje historii skutečných nákupů.
- FIRE používá nominální efektivní roční výnos a vklady na konci měsíce. Zahrnuje i záporné výnosy a nedosažitelné cíle; nezahrnuje daně, poplatky a volatilitu.

## Regresní testy

Testy ve `tests/` ověřují nezávisle spočítané příklady: měny a znaménka, cash flow a benchmark, práci s XML, opční multiplikátory a oddělení účtů, daňové hranice a složené úročení. Neobsahují reálné přihlašovací údaje ani celý osobní report.
