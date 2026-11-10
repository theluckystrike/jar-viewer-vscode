package com.example.inventory;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/** A small inventory used as the JAR Viewer sample. */
public class Inventory {
    public static final String UNIT = "pcs";

    public enum Category { TOOLS, PARTS, SUPPLIES }

    public static final class Item {
        private final String sku;
        private final Category category;
        private int quantity;

        public Item(String sku, Category category, int quantity) {
            this.sku = sku;
            this.category = category;
            this.quantity = quantity;
        }

        public String sku() { return sku; }
        public Category category() { return category; }
        public int quantity() { return quantity; }
    }

    private final List<Item> items = new ArrayList<>();

    public void add(String sku, Category category, int quantity) {
        if (quantity < 0) {
            throw new IllegalArgumentException("quantity must not be negative: " + quantity);
        }
        items.add(new Item(sku, category, quantity));
    }

    public Optional<Item> find(String sku) {
        return items.stream().filter(i -> i.sku().equals(sku)).findFirst();
    }

    public int total(Category category) {
        int sum = 0;
        for (Item i : items) {
            if (i.category() == category) {
                sum += i.quantity();
            }
        }
        return sum;
    }

    public static String shelf(Category category) {
        switch (category) {
            case TOOLS: return "A1";
            case PARTS: return "B2";
            default: return "C3";
        }
    }

    public <T extends Comparable<T>> List<Item> sortedBy(java.util.function.Function<Item, T> key) {
        List<Item> copy = new ArrayList<>(items);
        copy.sort(Comparator.comparing(key));
        return copy;
    }
}
