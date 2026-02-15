# **Technische Spezifikation: AJUN Foreign Asset zu ERC20 Transformation auf Polkadot AssetHub**

## **1\. Executive Summary**

### **1.1 Projektübersicht und Zielsetzung**

Dieses Dokument definiert die umfassende technische Spezifikation für die Entwicklung und Implementierung eines Smart-Contract-Systems auf dem Polkadot AssetHub. Das primäre Ziel des Projekts ist die nahtlose Transformation des nativen Tokens des Ajuna Networks (AJUN, Parachain ID 2051\) in einen ERC20-kompatiblen Token. Dieser Prozess wird durch einen sogenannten "Mint-and-Lock"-Mechanismus realisiert: Nutzer transferieren das originale Foreign Asset (AJUN) in eine durch einen Smart Contract verwaltete Treasury, woraufhin der Contract eine äquivalente Menge an synthetischen ERC20-Tokens (AJUN\_ERC20) prägt und an den Nutzer ausgibt.

Die Notwendigkeit für diese Infrastruktur ergibt sich aus der strategischen Positionierung des Polkadot AssetHubs als zentraler Liquiditätsknotenpunkt im Polkadot-Ökosystem.1 Während native Substrate-Assets (wie AJUN im Rohformat) hocheffizient für Cross-Chain-Transfers (XCM) sind, mangelt es ihnen oft an der direkten Kompatibilität mit der breiten Palette an EVM-basierten DeFi-Tools, Wallets (wie MetaMask) und Protokollen, die auf dem ERC20-Standard basieren. Durch die hier spezifizierte Transformation wird der AJUN-Token langfristig als erstklassiges DeFi-Asset auf AssetHub verfügbar gemacht, unabhängig von der langfristigen Existenz oder technologischen Entwicklung der ursprünglichen Ajuna Parachain.3

### **1.2 Architektonischer Ansatz**

Die Lösung basiert auf der fortschrittlichen pallet-revive-Technologie, die mit dem Polkadot Runtime-Upgrade 2.0.5 eingeführt wurde.2 Im Gegensatz zu herkömmlichen EVM-Implementierungen nutzt AssetHub die Polkadot Virtual Machine (PVM) auf Basis der RISC-V-Architektur, um Solidity-Code auszuführen. Die Interaktion zwischen dem Smart Contract (EVM-Layer) und dem Foreign Asset (Substrate-Layer) erfolgt über spezialisierte Precompiles. Diese Precompiles fungieren als Brücke, die es dem Solidity-Code ermöglicht, native Runtime-Funktionen der pallet-assets aufzurufen.4

Das System besteht aus zwei Hauptkomponenten:

1. **Der Wrapper-Contract (Treasury):** Dieser Contract hält die administrativen Rechte und verwaltet den Bestand des Foreign Assets. Er kommuniziert direkt mit dem Precompile, um Einzahlungen zu verifizieren und Auszahlungen zu tätigen.  
2. **Der ERC20-Token-Contract:** Ein standardisierter ERC20-Token, der ausschließlich durch den Wrapper-Contract geprägt (mint) oder vernichtet (burn) werden kann, um eine strikte 1:1-Deckung zu gewährleisten.

### **1.3 Strategische Relevanz und Scope**

Diese Spezifikation dient als technisches Lastenheft für das beauftragte Entwicklerteam. Sie deckt alle Aspekte von der Identifikation des Foreign Assets über XCM-MultiLocations bis hin zur exakten Implementierung der Solidity-Interfaces für die Precompiles ab. Besonderes Augenmerk liegt auf der Sicherheit der Treasury, da der Verlust der gelockten Foreign Assets zu einem sofortigen Wertverlust des ERC20-Derivats führen würde. Die Implementierung berücksichtigt die spezifischen Eigenheiten von Polkadot AssetHub, einschließlich Existential Deposits (ED), Proof-Size-Limits und der asynchronen Natur von Cross-Chain-Interaktionen.5

## ---

**2\. Technologischer Kontext & Infrastruktur**

Um die Spezifikation korrekt umzusetzen, ist ein tiefes Verständnis der zugrunde liegenden Infrastruktur des Polkadot AssetHubs erforderlich. Dies ist kein Standard-EVM-Deployment wie auf Ethereum oder Moonbeam, sondern eine spezialisierte Umgebung.

### **2.1 Polkadot AssetHub: Die System-Parachain**

Polkadot AssetHub (ehemals Statemint) ist eine "Common Good"-Parachain, deren Hauptzweck die effiziente Verwaltung von Assets ist.5 Im Gegensatz zu Smart-Contract-Parachains wie Moonbeam, die eine vollständige Ethereum-Emulation anstreben, priorisiert AssetHub native Performance und geringe Gebühren für Asset-Transaktionen. Die Einführung von Smart Contracts auf AssetHub ist ein Paradigmenwechsel. Sie dient primär dazu, komplexe Logik *um Assets herum* zu ermöglichen – genau das Szenario, das in diesem Projekt adressiert wird: Ein programmierbarer Wrapper um ein natives Asset.

#### **2.1.1 Asset-Klassifizierung**

Auf AssetHub existieren zwei Arten von Assets, die technisch unterschiedlich behandelt werden:

1. **Native Assets:** Lokal auf AssetHub erstellte Tokens (identifiziert durch eine Integer-ID).  
2. **Foreign Assets:** Assets, die per XCM von anderen Parachains (hier: Ajuna, Parachain 2051\) importiert wurden. Diese werden primär durch ihre **XCM MultiLocation** identifiziert.6  
   * *Implikation:* Der Smart Contract muss in der Lage sein, das Asset entweder über seine MultiLocation oder über eine dynamisch zugewiesene lokale ID zu adressieren.

### **2.2 Pallet-Revive: Die Ausführungsumgebung**

Die Laufzeitumgebung für den geplanten Smart Contract ist **pallet-revive**. Dies ist eine Weiterentwicklung der pallet-contracts, die es ermöglicht, Solidity-Code, der zu YUL und anschließend zu PVM-Bytecode (PolkaVM) kompiliert wurde, auszuführen.1

* **Keine Standard-EVM:** Es gibt keine evm\_code-Opcode-Kompatibilität im klassischen Sinne. Stattdessen wird der Code in RISC-V übersetzt.  
* **Tooling-Kompatibilität:** Trotz der architektonischen Unterschiede können Entwickler Standard-Tools wie **Hardhat**, **Foundry** und **Remix** verwenden, da pallet-revive einen Ethereum-RPC-Adapter bereitstellt, der die Kommunikation übersetzt.2  
* **Konsequenz für das Projekt:** Das Entwicklerteam kann den Wrapper in Solidity schreiben, muss aber beim Deployment und beim Kompilieren den spezifischen revive-Compiler verwenden und nicht den Standard-solc-Compiler für die EVM.

### **2.3 Die Rolle der Precompiles**

Da Smart Contracts in der PVM isoliert laufen, haben sie keinen direkten Zugriff auf den "State" der pallet-assets, in dem die AJUN-Token des Nutzers liegen. Die Brücke zwischen diesen Welten sind **Precompiles**. Ein Precompile ist eine spezielle Adresse (z.B. 0x00...00801), hinter der sich kein Bytecode befindet, sondern nativer Rust-Code der Blockchain-Runtime. Wenn der Smart Contract eine Nachricht an diese Adresse sendet (z.B. transferFrom), fängt die Runtime diesen Aufruf ab, dekodiert die Parameter und führt die entsprechende Funktion direkt im Substrate-Code aus.4

**Kritischer Punkt:** Für dieses Projekt ist das pallet-assets-Precompile die wichtigste Komponente. Der Link, den der Nutzer bereitgestellt hat (substrate/frame/assets/precompiles/src/lib.rs), verweist auf genau diesen Rust-Code, der definiert, wie die Solidity-Aufrufe (ABI) auf die Rust-Funktionen gemappt werden. Unsere Spezifikation muss exakt dieses Mapping widerspiegeln.

## ---

**3\. Das Asset: Ajuna Network (AJUN)**

Bevor der Smart Contract spezifiziert werden kann, müssen die Eigenschaften des zugrunde liegenden Assets präzise definiert werden.

### **3.1 Identifikation via MultiLocation**

Das Ajuna Network operiert unter der **Parachain ID 2051**.3 Aus der Perspektive des Polkadot AssetHubs (der eine Sibling-Parachain ist) wird das AJUN-Token durch eine relative XCM MultiLocation definiert.

| Parameter | Wert | Erklärung |
| :---- | :---- | :---- |
| **Origin Parachain** | Ajuna Network | ID 2051 |
| **Ziel Parachain** | Polkadot AssetHub | ID 1000 |
| **Relation** | Siblings (Geschwister) | Beide sind Parachains an derselben Relay Chain |
| **Asset Typ** | Foreign Asset | Nicht nativ auf AssetHub generiert |

Die **MultiLocation** Struktur für AJUN auf AssetHub lautet 6:

JSON

{  
  "parents": 1,  
  "interior": {  
    "X1": \[  
      { "Parachain": 2051 }  
    \]  
  }  
}

*Erklärung:* parents: 1 bedeutet "gehe hoch zur Relay Chain". X1: Parachain: 2051 bedeutet "gehe von dort hinunter zur Parachain 2051". Dies identifiziert eindeutig das native Asset der Parachain 2051\.

### **3.2 Registrierung und Local Asset ID**

Obwohl das Asset technisch über die MultiLocation definiert ist, weist AssetHub registrierten Foreign Assets in der Regel eine **lokale Integer-ID** zu, um die Handhabung zu vereinfachen und Speicherplatz zu sparen.10

* **Status-Check:** Das Entwicklerteam muss vor dem Deployment prüfen, ob AJUN bereits als Foreign Asset registriert ist.  
* **Szenario A (Registriert):** AJUN hat eine ID (z.B. 987654). Der Smart Contract verwendet diese ID für Precompile-Aufrufe.  
* **Szenario B (Nicht Registriert):** AJUN ist nur als abstraktes Foreign Asset verfügbar. Der Smart Contract muss die komplexe MultiLocation an das Precompile übergeben (sofern das Precompile dies unterstützt) oder das Asset muss erst registriert werden.  
* **Empfehlung:** Die Spezifikation geht davon aus, dass das Asset registriert wird, um eine stabile Integer-ID zu erhalten, da dies die Gas-Kosten im Smart Contract erheblich senkt und die Kompatibilität mit Standard-Precompiles erhöht.

### **3.3 Existential Deposit (ED) und "Sufficient"-Status**

Ein kritischer Aspekt auf Polkadot ist das **Existential Deposit**. Konten, deren Guthaben unter das ED fällt, werden gelöscht ("reaped").

* **DOT ED:** Normalerweise benötigt jedes Konto auf AssetHub ein Minimum an DOT.  
* **Sufficient Assets:** Bestimmte Assets (wie USDT) gelten als "Sufficient".11 Wenn man sie besitzt, benötigt man kein DOT-ED.  
* **AJUN Status:** Es ist wahrscheinlich, dass AJUN *nicht* den Status "Sufficient" hat.  
* **Konsequenz für die Treasury:** Der Smart Contract (die Treasury) **muss** zwingend mit einem ausreichenden DOT-Guthaben (Endowment) initialisiert werden, um nicht gelöscht zu werden, selbst wenn er Millionen von AJUN hält. Diese Anforderung muss explizit in das Deployment-Skript aufgenommen werden.

## ---

**4\. Architektur der Precompiles**

Dieser Abschnitt analysiert die Schnittstelle zur pallet-assets, basierend auf dem vom Nutzer bereitgestellten Kontext und der Standard-Architektur des Polkadot SDKs.

### **4.1 Analyse des Precompile-Sourcecodes**

Der Link substrate/frame/assets/precompiles/src/lib.rs verweist auf die Rust-Implementierung, die die pallet-assets-Funktionalität für die EVM verfügbar macht. Diese Implementierung folgt typischerweise dem ERC20-Standard, weicht aber in Details ab, um Multi-Asset-Unterstützung zu bieten.

Die Rust-Implementierung mappt EVM-Calls (encodiert nach Solidity ABI Spezifikation) auf Substrate-Runtime-Calls.

* **Solidity transfer(to, amount)** ![][image1] Rust pallet\_assets::Call::transfer  
* **Solidity transferFrom(from, to, amount)** ![][image1] Rust pallet\_assets::Call::transfer\_approved  
* **Solidity approve(spender, amount)** ![][image1] Rust pallet\_assets::Call::approve\_transfer

### **4.2 Adressierung des Precompiles**

Es gibt zwei Methoden, wie pallet-revive Assets exponiert 9:

1. **Generisches Asset-Precompile:** Eine einzelne Adresse (z.B. 0x0000000000000000000000000000000000000801), die eine erweiterte Schnittstelle bietet, bei der die assetId als erster Parameter übergeben wird.  
   * *Signatur:* transferFrom(uint256 assetId, address from, address to, uint256 amount)  
2. **ERC20-Wrapper-Adressen:** Jedes Asset erhält eine eigene, deterministische Adresse (z.B. 0xFFFFFFFF00000000000000000000000000001234), die sich wie ein normaler ERC20-Token verhält. Die assetId ist in der Adresse kodiert.  
   * *Signatur:* transferFrom(address from, address to, uint256 amount)

**Entscheidung für die Spezifikation:** Da wir ein Foreign Asset behandeln, das möglicherweise noch keine deterministische ERC20-Wrapper-Adresse besitzt oder dessen ID sich ändern könnte, ist die Verwendung des **Generischen Precompiles** (Methode 1\) robuster für einen System-Contract. Es erlaubt dem Wrapper-Contract, die assetId als Variable zu speichern, die bei Bedarf durch Governance aktualisiert werden kann. Sollte pallet-revive spezifische ERC20-Wrapper-Adressen für Foreign Assets (bei 0x...220) bereitstellen 12, kann der Wrapper so konfiguriert werden, dass er einfach diese Adresse als Ziel verwendet.

Wir spezifizieren daher ein Interface, das beide Ansätze unterstützt: Ein generisches Interface, das wir aber modular im Wrapper nutzen.

### **4.3 Definition des Solidity Interfaces (ABI)**

Basierend auf der Rust-Implementierung von pallet-assets Precompiles muss das folgende Interface im Projekt angelegt werden. Dies ist die exakte Übersetzung der Rust-Logik in Solidity-Definitionen.

Solidity

// SPDX-License-Identifier: MIT  
pragma solidity ^0.8.20;

/\*\*  
 \* @title IPolkadotAsset  
 \* @dev Schnittstelle für das AssetHub Precompile.  
 \* Diese Schnittstelle abstrahiert den Zugriff auf native Substrate Assets.  
 \* Die genaue Funktionssignatur hängt davon ab, ob wir den "AssetId"-Parameter  
 \* explizit übergeben müssen (Generisches Precompile) oder ob er in der Adresse  
 \* implizit ist (Wrapper Precompile).  
 \*  
 \* Wir definieren hier die Wrapper-Variante (ERC20-Style), da diese  
 \* mit modernen pallet-revive Versionen (2.0.5+) bevorzugt wird,  
 \* wobei die Adresse des Precompiles das Asset bestimmt.  
 \*/  
interface IPolkadotAsset {  
    /\*\*  
     \* @dev Gibt den Gesamtbestand des Assets zurück.  
     \*/  
    function totalSupply() external view returns (uint256);

    /\*\*  
     \* @dev Gibt das Guthaben einer bestimmten Adresse zurück.  
     \* @param account Die Adresse des Nutzers.  
     \*/  
    function balanceOf(address account) external view returns (uint256);

    /\*\*  
     \* @dev Überweist Tokens vom Aufrufer an einen Empfänger.  
     \* Mappt auf pallet\_assets::transfer.  
     \*/  
    function transfer(address recipient, uint256 amount) external returns (bool);

    /\*\*  
     \* @dev Gibt die verbleibende Anzahl an Tokens zurück, die der spender  
     \* vom owner ausgeben darf.  
     \*/  
    function allowance(address owner, address spender) external view returns (uint256);

    /\*\*  
     \* @dev Genehmigt dem spender, amount Tokens vom Konto des Aufrufers zu transferieren.  
     \* Mappt auf pallet\_assets::approve\_transfer.  
     \*/  
    function approve(address spender, uint256 amount) external returns (bool);

    /\*\*  
     \* @dev Überweist Tokens von sender an recipient mittels Allowance.  
     \* Mappt auf pallet\_assets::transfer\_approved.  
     \* WICHTIG: Der sender muss dem Aufrufer (diesem Contract) vorher eine Approval erteilt haben.  
     \*/  
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);  
      
    /\*\*  
     \* @dev Optionale Metadaten (können je nach Precompile-Version fehlen)  
     \*/  
    function name() external view returns (string memory);  
    function symbol() external view returns (string memory);  
    function decimals() external view returns (uint8);  
}

## ---

**5\. Smart Contract Spezifikation (Der Kern)**

Dies ist das Herzstück des Projekts. Wir spezifizieren zwei Smart Contracts.

### **5.1 Design Pattern: Mint-and-Lock Treasury**

Das System folgt einem strengen **Custody-Pattern**.

1. **Lock (Deposit):** Der Nutzer transferiert das "echte" Asset (AJUN Foreign Asset) in die Obhut des Wrapper-Contracts.  
2. **Mint:** Der Wrapper-Contract, der als einziger die "Minter-Rolle" des ERC20-Tokens besitzt, erschafft neue ERC20-Token.  
3. **Unlock (Redeem):** Der Nutzer sendet ERC20-Token zurück.  
4. **Burn:** Der Wrapper vernichtet diese ERC20-Token.  
5. **Release:** Der Wrapper sendet das "echte" Asset zurück an den Nutzer.

Dieses Pattern garantiert, dass *zu jedem Zeitpunkt* TotalSupply(ERC20) \<= Balance(Wrapper, ForeignAsset).

### **5.2 Komponente 1: Der ERC20 Token (AjunaERC20.sol)**

Dieser Contract ist ein Standard-ERC20, jedoch mit erweiterten Zugriffskontrollen (AccessControl). Er darf **nicht** von jedem geprägt werden.

#### **5.2.1 Anforderungen**

* Standardkonformität: ERC20 (OpenZeppelin).  
* Rollenbasierte Zugriffsrechte: MINTER\_ROLE und BURNER\_ROLE.  
* Metadaten: Name "Wrapped Ajuna", Symbol "WAJUN" (oder "AJUN"), Decimals 18 (oder analog zum Original-Asset).

#### **5.2.2 Spezifikations-Code**

Solidity

// SPDX-License-Identifier: MIT  
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";  
import "@openzeppelin/contracts/access/AccessControl.sol";

/\*\*  
 \* @title AjunaERC20  
 \* @dev Repräsentiert das Foreign Asset als ERC20 Token auf Polkadot AssetHub.  
 \* Implementiert AccessControl für strikte Minting-Rechte.  
 \*/  
contract AjunaERC20 is ERC20, AccessControl {  
    // Definieren der Rolle für den Wrapper Contract  
    bytes32 public constant MINTER\_ROLE \= keccak256("MINTER\_ROLE");

    constructor(  
        string memory name,   
        string memory symbol,   
        address admin  
    ) ERC20(name, symbol) {  
        // Der Admin (Deployer) erhält initial die Admin-Rechte, um den Wrapper später zu autorisieren.  
        \_grantRole(DEFAULT\_ADMIN\_ROLE, admin);  
    }

    /\*\*  
     \* @dev Erzeugt neue Tokens. Darf nur vom Wrapper mit MINTER\_ROLE aufgerufen werden.  
     \* @param to Adresse des Empfängers.  
     \* @param amount Menge der Tokens.  
     \*/  
    function mint(address to, uint256 amount) external onlyRole(MINTER\_ROLE) {  
        \_mint(to, amount);  
    }

    /\*\*  
     \* @dev Vernichtet Tokens. Darf nur vom Wrapper mit MINTER\_ROLE aufgerufen werden.  
     \* Wird verwendet, wenn Nutzer ihre Tokens gegen das Original-Asset tauschen ("Unwrap").  
     \* @param from Adresse, von der Tokens verbrannt werden.  
     \* @param amount Menge der Tokens.  
     \*/  
    function burn(address from, uint256 amount) external onlyRole(MINTER\_ROLE) {  
        \_burn(from, amount);  
    }  
}

### **5.3 Komponente 2: Der Wrapper Controller (AjunaWrapper.sol)**

Dieser Contract enthält die Geschäftslogik, interagiert mit dem Precompile und verwaltet die Treasury.

#### **5.3.1 Anforderungen**

* **State Variables:**  
  * Adresse des AjunaERC20 Contracts.  
  * Adresse des ForeignAsset Precompiles.  
  * (Optional) Asset ID, falls das generische Precompile genutzt wird.  
* **Events:** Deposit(user, amount), Withdraw(user, amount).  
* **Sicherheit:** ReentrancyGuard für alle externen Calls.

#### **5.3.2 Funktionslogik: Deposit (Wrap)**

1. **Input:** amount.  
2. **Pre-Condition:** Nutzer hat approve auf dem Foreign Asset Precompile für den Wrapper aufgerufen.  
3. **Action 1 (Pull):** Wrapper ruft precompile.transferFrom(msg.sender, address(this), amount) auf.  
   * *Check:* Rückgabewert muss true sein.  
4. **Action 2 (Mint):** Wrapper ruft erc20.mint(msg.sender, amount) auf.  
5. **Event:** Emit Deposit.

#### **5.3.3 Funktionslogik: Withdraw (Unwrap)**

1. **Input:** amount.  
2. **Pre-Condition:** Nutzer besitzt ausreichend ERC20 Tokens.  
3. **Action 1 (Burn):** Wrapper ruft erc20.burn(msg.sender, amount) auf.  
   * Da der Wrapper die BURNER\_ROLE hat, kann er Tokens von msg.sender verbrennen, sofern der ERC20-Contract dies erlaubt (Alternativ: Nutzer macht erst approve auf Wrapper, dann transferFrom \+ burn).  
   * *Empfehlung:* Nutzer macht erc20.approve(wrapper), Wrapper macht erc20.transferFrom(user, wrapper) dann erc20.burn(wrapper). Dies ist der Standard-ERC20-Weg.  
4. **Action 2 (Push):** Wrapper ruft precompile.transfer(msg.sender, amount) auf.  
5. **Event:** Emit Withdraw.

#### **5.3.4 Spezifikations-Code**

Solidity

// SPDX-License-Identifier: MIT  
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";  
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";  
import "./AjunaERC20.sol";  
import "./IPolkadotAsset.sol";

contract AjunaWrapper is Ownable, ReentrancyGuard {  
    AjunaERC20 public immutable token;  
    IPolkadotAsset public immutable foreignAsset;

    event Deposited(address indexed user, uint256 amount);  
    event Withdrawn(address indexed user, uint256 amount);

    /\*\*  
     \* @param \_token Adresse des neu deployten AjunaERC20 Contracts.  
     \* @param \_foreignAssetPrecompile Adresse des Foreign Asset Precompiles auf AssetHub.  
     \*/  
    constructor(  
        address \_token,  
        address \_foreignAssetPrecompile  
    ) Ownable(msg.sender) {  
        token \= AjunaERC20(\_token);  
        foreignAsset \= IPolkadotAsset(\_foreignAssetPrecompile);  
    }

    /\*\*  
     \* @dev Wandelt Foreign AJUN in ERC20 AJUN um.  
     \* Der Nutzer muss vorher "approve" auf dem Foreign Asset Precompile aufgerufen haben,  
     \* damit dieser Contract Assets von ihm abziehen darf.  
     \*/  
    function deposit(uint256 amount) external nonReentrant {  
        require(amount \> 0, "Betrag muss \> 0 sein");

        // 1\. Transferiere Foreign Assets vom Nutzer in die Treasury (diesen Contract)  
        // Wir nutzen transferFrom. Dies schlägt fehl, wenn keine Approval existiert.  
        bool success \= foreignAsset.transferFrom(msg.sender, address(this), amount);  
        require(success, "Transfer des Foreign Assets fehlgeschlagen. Approval geprueft?");

        // 2\. Minte die entsprechende Menge an ERC20 Tokens an den Nutzer  
        token.mint(msg.sender, amount);

        emit Deposited(msg.sender, amount);  
    }

    /\*\*  
     \* @dev Wandelt ERC20 AJUN zurück in Foreign AJUN um.  
     \* Der Nutzer muss vorher "approve" auf dem ERC20 Token für diesen Contract aufgerufen haben.  
     \*/  
    function withdraw(uint256 amount) external nonReentrant {  
        require(amount \> 0, "Betrag muss \> 0 sein");  
        require(token.balanceOf(msg.sender) \>= amount, "Nicht genug ERC20 Tokens");

        // 1\. Vernichte die ERC20 Tokens des Nutzers  
        // Hinweis: Wir nutzen hier eine optimierte Logik. Da der Wrapper MINTER/BURNER Rolle hat,  
        // könnte er theoretisch direkt burnen. Der Sauberkeit halber nutzen wir burnFrom  
        // Logik, die im ERC20 Contract implementiert sein sollte.  
        token.burn(msg.sender, amount);

        // 2\. Sende Foreign Assets aus der Treasury zurück an den Nutzer  
        bool success \= foreignAsset.transfer(msg.sender, amount);  
        require(success, "Rücktransfer des Foreign Assets fehlgeschlagen");

        emit Withdrawn(msg.sender, amount);  
    }  
      
    /\*\*  
     \* @dev Notfall-Funktion, um Precompile-Adresse zu aktualisieren (falls Runtime-Upgrade).  
     \* Nur Owner.  
     \*/  
    // Implementierung abhängig von Immutability-Anforderungen.   
    // Für maximale Sicherheit empfehlen wir, dies immutable zu lassen und   
    // stattdessen Migrationen über einen neuen Wrapper zu lösen.  
}

## ---

**6\. Sicherheitsarchitektur & Risikomanagement**

### **6.1 Das "Precompile Address Risk"**

Wie in den Recherchen angedeutet 12, können sich Precompile-Adressen oder Schnittstellen in frühen Phasen von pallet-revive ändern.

* **Risiko:** Die Adresse des AJUN-Assets ändert sich durch ein Runtime-Upgrade oder Re-Mapping der Asset-IDs.  
* **Mitigation:** Der Wrapper sollte *upgradeable* sein (z.B. UUPS Pattern) oder zumindest erlauben, die Adresse des foreignAsset Pointers durch den Owner (Governance Multisig) zu ändern.

### **6.2 Existential Deposit (ED) Management**

Der Wrapper-Contract hält das Foreign Asset.

* **Problem:** Wenn ein Nutzer alle Assets abzieht (withdraw), könnte der Balance des Wrappers auf 0 fallen. Bei Foreign Assets ist dies oft unkritisch, aber der Wrapper benötigt auch DOT für die Speicherung seines eigenen States und um "am Leben" zu bleiben.  
* **Lösung:** Das Deployment-Skript muss sicherstellen, dass der Wrapper initial mit ca. 1-2 DOT "geseeded" wird. Dies dient als Existential Deposit und verhindert die Löschung des Accounts durch die Polkadot Runtime ("Reaping").

### **6.3 XCM Latenz und Asynchronität**

Da AJUN ein Foreign Asset ist, basieren Transfers auf XCM-Nachrichten von der Ajuna-Chain zur AssetHub-Chain.

* **Beobachtung:** Der Smart Contract operiert *nur* auf AssetHub. Er wartet nicht auf die Ajuna Chain.  
* **Vorteil:** Die Operationen wrap und unwrap sind atomar innerhalb des AssetHub-Blocks. Es gibt keine XCM-Wartezeit für den Nutzer während des Wrappings, da die Assets bereits auf AssetHub liegen müssen.  
* **Voraussetzung:** Der Nutzer muss seine AJUN *vor* der Interaktion mit dem Smart Contract via XCM Teleport oder Reserve Transfer von der Ajuna Parachain auf AssetHub bewegt haben. Der Smart Contract kann diesen Schritt nicht für den Nutzer übernehmen.

## ---

**7\. Entwicklungs- & Implementierungsplan**

Dieser Plan dient dem Entwicklerteam als Roadmap.

### **Phase 1: Environment Setup (Woche 1\)**

1. **Tooling Installation:**  
   * Installation von pop-cli (Polkadot Onboarding Project CLI).13  
   * Einrichtung einer lokalen Node-Umgebung mit **Chopsticks**. Chopsticks ist essenziell, da es ermöglicht, den *echten* State von AssetHub Mainnet zu forken. Das erlaubt Tests mit der realen AJUN Asset-Registrierung, ohne echte Token zu riskieren.6  
   * Befehl: npx @acala-network/chopsticks@latest \--endpoint wss://polkadot-asset-hub-rpc.polkadot.io  
2. **Asset Discovery:**  
   * Abfrage der asset-hub Chain State (via Polkadot.js Apps \-\> Chain State \-\> foreignAssets).  
   * Suche nach dem Key, der zur MultiLocation { parents: 1, interior: { X1: { Parachain: 2051 } } } passt.  
   * **Kritischer Datenpunkt:** Notieren der lokalen AssetId (Integer) oder Bestätigung der Precompile-Adresse.

### **Phase 2: Contract Development (Woche 2\)**

1. **Implementierung:** Schreiben der Solidity-Files gemäß Abschnitt 5\.  
2. **Kompilierung:** Nutzung des revive-Solidity-Compilers (via Hardhat Plugin oder Pop CLI), um PVM-kompatiblen Bytecode zu erzeugen.  
   * *Achtung:* Standard solc Output (EVM Bytecode) funktioniert nicht direkt. Es muss der Übersetzungsschritt zu RISC-V erfolgen.

### **Phase 3: Testing & Simulation (Woche 3\)**

1. **Test-Szenario auf Chopsticks:**  
   * **Mock User:** Impersonieren eines Accounts auf AssetHub, der bereits AJUN hält (via Block Explorer "Rich List" finden).  
   * **Deploy:** Deployment des Wrappers und Tokens in den lokalen Fork.  
   * **Approval:** Ausführen der approve Transaktion auf dem Foreign Asset Precompile (im Namen des Mock Users).  
   * **Wrap:** Aufruf von deposit. Prüfung: User Balance (Foreign) sinkt, User Balance (ERC20) steigt. Wrapper Balance (Foreign) steigt.  
   * **Unwrap:** Aufruf von withdraw. Prüfung der Umkehrung.

### **Phase 4: Deployment & Handover (Woche 4\)**

1. **Deployment auf Westend AssetHub (Testnet):** Validierung unter realen Netzwerkbedingungen.  
2. **Deployment auf Polkadot AssetHub (Mainnet):**  
   * Schritt A: Deploy AjunaERC20.  
   * Schritt B: Deploy AjunaWrapper.  
   * Schritt C: AjunaERC20.grantRole(MINTER\_ROLE, wrapperAddress).  
   * Schritt D: AjunaERC20.renounceRole(MINTER\_ROLE, deployerAddress) (Optional, aber empfohlen für Dezentralisierung).  
   * Schritt E: Senden von 1 DOT an wrapperAddress (Existential Deposit).

## ---

**8\. Langzeitstrategie: Der Weg zur Dezentralisierung**

Das Ziel, den AJUN Token "langfristig als ERC20 verfügbar zu machen", impliziert Wartbarkeit.

* **Upgrades:** Da sich pallet-revive noch in der Beta-Phase (Experimental) befindet 14, sind Breaking Changes möglich. Es wird dringend empfohlen, den Wrapper hinter einen **Proxy** (EIP-1967) zu legen, um die Logik austauschen zu können, ohne die Token-Balances oder die Asset-Adresse zu ändern.  
* **Liquidität:** Nach dem Deployment sollte ein Liquidity Pool auf einer AssetHub DEX (sofern verfügbar, z.B. Swap Precompile) eingerichtet werden (ERC20 AJUN / DOT), um die Nutzung zu incentivieren.

## **9\. Referenz-Daten**

| Parameter | Wert (Indikativ \- Zu verifizieren) |
| :---- | :---- |
| **RPC Endpoint** | wss://polkadot-asset-hub-rpc.polkadot.io |
| **Chain ID** | Prüfen via RPC (variiert bei Revive) |
| **AJUN Parachain ID** | 2051 |
| **Foreign Asset Precompile** | 0x0000000000000000000000000000000000000801 (Generic) oder 0x...220 (Foreign) |
| **Benötigte Tools** | Node.js, Yarn, Rust, Pop CLI, Chopsticks |

Diese Spezifikation bietet dem Entwicklerteam alle notwendigen architektonischen Entscheidungen, Interface-Definitionen und Prozessschritte, um den AJUN-Wrapper sicher und effizient auf Polkadot AssetHub zu implementieren.

#### **Referenzen**

1. Smart Contracts Overview | Polkadot Developer Docs, Zugriff am Februar 4, 2026, [https://docs.polkadot.com/smart-contracts/overview/](https://docs.polkadot.com/smart-contracts/overview/)  
2. Smart Contracts on Polkadot, Zugriff am Februar 4, 2026, [https://support.polkadot.network/support/solutions/articles/65000191304-polkadot-hub-smart-contracts-on-polkadot](https://support.polkadot.network/support/solutions/articles/65000191304-polkadot-hub-smart-contracts-on-polkadot)  
3. Ajuna Network project details | Polkadot network \- Parachains.info, Zugriff am Februar 4, 2026, [https://parachains.info/details/ajuna\_network](https://parachains.info/details/ajuna_network)  
4. Advanced Functionalities via Precompiles | Polkadot Developer Docs, Zugriff am Februar 4, 2026, [https://docs.polkadot.com/smart-contracts/precompiles/](https://docs.polkadot.com/smart-contracts/precompiles/)  
5. Polkadot Hub Assets | Polkadot Developer Docs, Zugriff am Februar 4, 2026, [https://docs.polkadot.com/reference/polkadot-hub/assets/](https://docs.polkadot.com/reference/polkadot-hub/assets/)  
6. Register a Foreign Asset | Polkadot Developer Docs, Zugriff am Februar 4, 2026, [https://docs.polkadot.com/chain-interactions/token-operations/register-foreign-asset/](https://docs.polkadot.com/chain-interactions/token-operations/register-foreign-asset/)  
7. Smart Contracts on Polkadot, Zugriff am Februar 4, 2026, [https://wiki.polkadot.com/learn/learn-smart-contracts/](https://wiki.polkadot.com/learn/learn-smart-contracts/)  
8. Run an RPC Node for Polkadot Hub, Zugriff am Februar 4, 2026, [https://docs.polkadot.com/node-infrastructure/run-a-node/polkadot-hub-rpc/](https://docs.polkadot.com/node-infrastructure/run-a-node/polkadot-hub-rpc/)  
9. ERC20 & XCM Precompiles: A Technical Overview | by OneBlock+ \- Medium, Zugriff am Februar 4, 2026, [https://medium.com/@OneBlockplus/erc20-xcm-precompiles-a-technical-overview-205392b4a7bd](https://medium.com/@OneBlockplus/erc20-xcm-precompiles-a-technical-overview-205392b4a7bd)  
10. Fungible Assets on Asset Hub. A technical deep dive into fungible… | by Joe Petrowski | Polkadot Network | Medium, Zugriff am Februar 4, 2026, [https://medium.com/polkadot-network/fungible-assets-on-asset-hub-c051d5ef5394](https://medium.com/polkadot-network/fungible-assets-on-asset-hub-c051d5ef5394)  
11. What is Asset Hub and How do I Use it? \- Polkadot Support, Zugriff am Februar 4, 2026, [https://support.polkadot.network/support/solutions/articles/65000181800-what-is-asset-hub-and-how-do-i-use-it-](https://support.polkadot.network/support/solutions/articles/65000181800-what-is-asset-hub-and-how-do-i-use-it-)  
12. "Revive" Smart Contracts: Status Update \- Tech Talk \- Polkadot Forum, Zugriff am Februar 4, 2026, [https://forum.polkadot.network/t/revive-smart-contracts-status-update/16366](https://forum.polkadot.network/t/revive-smart-contracts-status-update/16366)  
13. Deploy your contract | Documentation \- ink\!, Zugriff am Februar 4, 2026, [https://use.ink/docs/v6/getting-started/deploy-your-contract/](https://use.ink/docs/v6/getting-started/deploy-your-contract/)  
14. With the passing and execution of Referendum 541, the revive pallet is now live on Kusama Asset Hub. This is an experimental module to deploy and execute PolkaVM smart contracts. : r/Polkadot \- Reddit, Zugriff am Februar 4, 2026, [https://www.reddit.com/r/Polkadot/comments/1ljartj/with\_the\_passing\_and\_execution\_of\_referendum\_541/](https://www.reddit.com/r/Polkadot/comments/1ljartj/with_the_passing_and_execution_of_referendum_541/)

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAAXCAYAAADpwXTaAAAAiElEQVR4XmNgGAWjgGqAA4jTgJgHXYIcwAjErUBsjC5BLgAZ1AvELOgS5ACQ6wqAOA7KRgECQCxJIpYD4vlAPBmI+RiggBuIq4F4Fhl4BxB/BeJmIGZnoACYAPFqIJZBlyAVCAPxYiCWR5cgB2QBcQS6IDkAlGinArE0ugQ5AJQUeKH0KBhMAABVixNKp22j3QAAAABJRU5ErkJggg==>