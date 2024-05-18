class Player {
    constructor(balance) {
        this.balance = balance;
        this.inventory = [];
        this.updateBalance(); // Lägg till detta för att uppdatera balansen när spelaren skapas
    }

    // Metod för att uppdatera balansen
    updateBalance() {
        document.getElementById('balance').textContent = `Balance: ${this.balance} coins`;
    }

    openBox() {
        if (this.balance < 100) {
            this.displayMessage("Du har inte tillräckligt med coins för att öppna lådan.");
            return;
        }

        // Dra 100 coins från balansen
        this.balance -= 100;
        this.updateBalance(); // Uppdatera balansen efter att ha dragit från den

        // Fortsätt med resten av koden
    }

    sellBox(index) {
        let boxType = this.inventory[index];
        let boxValues = this.getBoxValues();

        if (index !== -1) {
            this.inventory.splice(index, 1);
            this.balance += boxValues[boxType];
            this.updateBalance(); // Uppdatera balansen efter att ha sålt boxen
            this.displayMessage(`Du har sålt ${boxType} för ${boxValues[boxType]} coins.\nDin nya balans är ${this.balance} coins.`);
            this.showInventory();
        } else {
            this.displayMessage(`Du har ingen ${boxType} i ditt inventory.`);
        }
    }

    // Resten av koden
}

        this.animateOpening(() => {
            let boxType = this.getRandomBox();
            this.inventory.push(boxType);
            this.displayMessage(`Grattis! Du fick ${boxType}.\nDin nya balans är ${this.balance} coins.`);
            this.showInventory();
        });
    }

    animateOpening(callback) {
        let animationElement = document.getElementById('animation');
        let boxes = Object.keys(this.getProbabilities());
        let index = 0;
        animationElement.style.display = 'flex';
        let interval = setInterval(() => {
            animationElement.textContent = boxes[index];
            index = (index + 1) % boxes.length;
        }, 100);

        setTimeout(() => {
            clearInterval(interval);
            animationElement.style.display = 'none';
            callback();
        }, 2000); // 2 seconds animation
    }

    getProbabilities() {
        return {
            'Box 1': 0.25,
            'Box 2': 0.20,
            'Box 3': 0.15,
            'Box 4': 0.10,
            'Box 5': 0.10,
            'Box 6': 0.08,
            'Box 7': 0.05,
            'Box 8': 0.03,
            'Box 9': 0.02,
            'Box 10': 0.02
        };
    }

    getRandomBox() {
        let probabilities = this.getProbabilities();
        let boxes = Object.keys(probabilities);
        let probs = Object.values(probabilities);
        let boxType = boxes[this.weightedRandomIndex(probs)];
        return boxType;
    }

    weightedRandomIndex(weights) {
        let sum = weights.reduce((acc, weight) => acc + weight, 0);
        let value = Math.random() * sum;
        for (let i = 0; i < weights.length; i++) {
            value -= weights[i];
            if (value <= 0) {
                return i;
            }
        }
        return weights.length - 1;
    }

    showInventory() {
        let output = document.getElementById('output');
        output.innerHTML = '';
        if (this.inventory.length === 0) {
            output.textContent = "Ditt inventory är tomt.";
        } else {
            this.inventory.forEach((box, index) => {
                let value = this.getBoxValue(box);
                let boxItem = document.createElement('div');
                boxItem.className = 'box-item';
                boxItem.innerHTML = `
                    ${box}: Värde ${value} coins
                    <button onclick="player.sellBox(${index})">Sälj</button>
                `;
                output.appendChild(boxItem);
            });
        }
    }


    getBoxValues() {
        return {
            'Box 1': 50,
            'Box 2': 75,
            'Box 3': 100,
            'Box 4': 150,
            'Box 5': 200,
            'Box 6': 250,
            'Box 7': 300,
            'Box 8': 400,
            'Box 9': 500,
            'Box 10': 1000
        };
    }

    getBoxValue(boxType) {
        let boxValues = this.getBoxValues();
        return boxValues[boxType] || 0;
    }

    displayMessage(message) {
        document.getElementById('output').textContent = message;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.player = new Player(500);

    document.getElementById('openBoxBtn').addEventListener('click', () => {
        player.openBox();
    });

    document.getElementById('showInvBtn').addEventListener('click', () => {
        player.showInventory();
    });
});
