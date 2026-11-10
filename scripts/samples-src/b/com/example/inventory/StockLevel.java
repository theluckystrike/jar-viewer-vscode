package com.example.inventory;

public record StockLevel(String sku, int onHand, int reorderAt) {
    public boolean needsReorder() {
        return onHand <= reorderAt;
    }
}
