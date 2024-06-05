let balance = 100;
let bet = 10;
const symbols = ["🍒", "🍋", "🍉", "🍇", "🍓", "🍍", "⭐"];
const reels = ['reel1', 'reel2', 'reel3'];

document.getElementById('spinButton').addEventListener('click', spin);
document.getElementById('increaseBetButton').addEventListener('click', increaseBet);
document.getElementById('decreaseBetButton').addEventListener('click', decreaseBet);

function spin() {
    if (bet > balance) {
        displayMessage("Insufficient balance");
        return;
    }

    balance -= bet;
    updateBalance();
    disableControls(true);

    let results = [];
    for (let reel of reels) {
        let result = getRandomSymbol();
        document.getElementById(reel).textContent = result;
        document.getElementById(reel).classList.add('spin');
        results.push(result);
    }

    setTimeout(() => {
        for (let reel of reels) {
            document.getElementById(reel).classList.remove('spin');
        }
        checkResults(results);
        updateBalance();
        disableControls(false);
    }, 1000);
}

function checkResults(results) {
    const paylines = [
        [results[0], results[1], results[2]],
        [results[0], results[0], results[0]],
        [results[2], results[2], results[2]]
    ];

    let totalWinnings = 0;

    paylines.forEach(line => {
        if (line[0] === line[1] && line[1] === line[2]) {
            if (line[0] === "⭐") {
                totalWinnings += bet * 20;
            } else {
                totalWinnings += bet * 10;
            }
        }
    });

    if (totalWinnings > 0) {
        balance += totalWinnings;
        displayMessage(`You win $${totalWinnings}!`);
    } else {
        displayMessage("You lose!");
    }

    // Check for bonus symbol
    if (results.includes("⭐")) {
        balance += bet * 5; // Simple bonus: win 5x the bet if ⭐ appears
        displayMessage(`Bonus win! You gain $${bet * 5}!`);
    }
}

function increaseBet() {
    bet += 10;
    updateBet();
}

function decreaseBet() {
    if (bet > 10) {
        bet -= 10;
    }
    updateBet();
}

function getRandomSymbol() {
    return symbols[Math.floor(Math.random() * symbols.length)];
}

function updateBalance() {
    document.getElementById('balance').textContent = balance;
}

function updateBet() {
    document.getElementById('bet').textContent = bet;
}

function displayMessage(message) {
    document.getElementById('message').textContent = message;
}

function disableControls(disable) {
    document.getElementById('spinButton').disabled = disable;
    document.getElementById('increaseBetButton').disabled = disable;
    document.getElementById('decreaseBetButton').disabled = disable;
}

