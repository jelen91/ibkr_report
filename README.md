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
- Pro Flex zapněte Account Information, Net Asset Value (NAV) in Base, Open Positions (SUMMARY, pro přesnou daň i Lot), Cash Report, Statement of Funds, Trades (Execution a Closed Lots) a Conversion Rates. Volitelně FX Positions, ze kterých Výkonnost vs. index ukazuje hotovost podle měn. Použijte datum YYYYMMDD a pro historii Last 365 Calendar Days.
- Denní výkonnost očišťuje NAV o doložené externí pohyby. Při chybějící intradenní valuaci používá deklarovanou denní konvenci; nejde o ověření shody s oficiálním IBKR TWR. Chybějící datum NAV se přiřadí k nejbližšímu následujícímu snapshotu, nikoli podle velikosti tržního výnosu.
- Hodnoty různých měn se nesčítají bez přepočtu. Chybějící FX ani neoceněná pozice nejsou nula. Duplicity účtů a neslučitelné reporty se odmítají.
- Daňová část je scénář, ne české daňové přiznání. S Closed Lots se zisk z obchodů počítá česky: prodej v korunách minus nákup v korunách, buď denními kurzy, nebo jednotným ročním kurzem (§ 38 ZDP); Výkonnost vs. index spočítá obojí a použije levnější variantu. Jednotný kurz běžného roku se do vyhlášení GFŘ odhaduje z kurzů IBKR ke konci měsíců. Bez lotů zůstává brokerovo P/L přepočtené kurzem dne prodeje. Kurzy jsou z IBKR, ne z ČNB; loty před začátkem exportu, další příjmy a nárok na zahraniční zápočet mohou vyžadovat další doklady. Omezení se zobrazují u výpočtu.
- Záložka Výkonnost vs. index je osobní roční přehled v CZK bez daňových přepínačů: uzavřít IBKR pozice a dlouhodobě držet akumulační CSPX, se stejnými vklady a výběry. Hlavní výsledek ukazuje čistý rozdíl v korunách po daních i dopadu na paušální režim a pod ním rozpad: hrubý rozdíl, daň po koších, složky ztráty paušálu, zdroje zisku tradingu (realizované/otevřené pozice, dividendy, úroky, kurzové rozdíly jako dopočet), cenu a kurz indexu, jednotlivé nákupy indexu a denní vývoj hrubého rozdílu. Vedle TWR (jak ho ukazuje IBKR) je zhodnocení vložených peněz (Modified Dietz), které odpovídá rozdílu v korunách. Index se oceňuje závěrečnou cenou SPY v New Yorku, tedy ve stejnou chvíli jako NAV z IBKR, s dividendami reinvestovanými po 15% srážce jako u CSPX; londýnský close CSPX je o 4,5 hodiny dřív a srovnání posouval o desítky tisíc Kč. Chybí-li na Yahoo denní close pro obchodní den, doplní se poslední hodinovou cenou téhož dne; zůstane-li cena k začátku, dni vkladu nebo konci starší, stránka na to upozorní. Drží-li účet pozice už k 31.12., stránka upozorní, že brokerovo P/L a daň z uzavření je počítají od nákupu (pro přesnou hodnotu pozic zapněte v NAV sloupec Cash).
- Profil odpovídá potvrzeným údajům: příjem OSVČ 1,2 mil. Kč, 60% výdajový paušál, zanedbatelné skutečné výdaje, hlavní činnost celý rok, první pásmo paušální daně a základní sleva. Editovat lze pouze roční příjem v rozsahu tohoto profilu; staré scénářové preference se nepřebírají.
- Za každý rok a strategii se automaticky použije výhodnější dostupný způsob zdanění zahraničních dividend (společný progresivní / samostatný 15% základ). Zahraniční zápočet dividend je omezen skutečnou srážkou a 15 % příjmu, úrokové srážky zůstávají bez automatického zápočtu. Neověřená refundace se nepřičítá. Je to modelová optimalizace podle dostupných údajů, nikoli záruka nejnižší možné skutečné daně.
- Souhrnná historie mimo IBKR používá dnešní množství a historické ceny; ruční položky drží konstantní hodnotu. Nepředstavuje historii skutečných nákupů.
- FIRE používá nominální efektivní roční výnos a vklady na konci měsíce. Zahrnuje i záporné výnosy a nedosažitelné cíle; nezahrnuje daně, poplatky a volatilitu.

## Regresní testy

Testy ve `tests/` ověřují nezávisle spočítané příklady: měny a znaménka, cash flow a benchmark, práci s XML, opční multiplikátory a oddělení účtů, daňové hranice a složené úročení. Neobsahují reálné přihlašovací údaje ani celý osobní report.
